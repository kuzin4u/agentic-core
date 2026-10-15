// PgHoldLedger (К6 п. 10, К9): векторы holds на PostgreSQL, bigint на границе, CHECK в базе.
// Без DATABASE_URL — пропуск; в CI пропуск ловит страж в tests/pg.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { applyMigrations, PgHoldLedger, HoldError } from "../src/index.js";
import { runHoldVectors } from "./holds-vectors.js";

const DATABASE_URL = process.env.DATABASE_URL;
const MAX = Number.MAX_SAFE_INTEGER;
const R = (amount: number) => ({ amount, currency: "RUB" });
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as HoldError).code ?? (e as Error).name; } return "ok"; };

/** Своя схема на каждый блок: expire в векторах затрагивает все удержания таблицы. */
function schema(name: string, max = 25) {
  const s = `h_${name}_${process.pid}_${Date.now()}`;
  const ctx = { admin: undefined as pg.Pool | undefined, db: undefined as unknown as pg.Pool };
  beforeAll(async () => {
    ctx.admin = new pg.Pool({ connectionString: DATABASE_URL });
    await ctx.admin.query(`CREATE SCHEMA ${s}`);
    ctx.db = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${s}`, max });
    await applyMigrations(ctx.db);
  });
  afterAll(async () => {
    await ctx.db?.end();
    await ctx.admin?.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await ctx.admin?.end();
  });
  return ctx;
}

describe.skipIf(!DATABASE_URL)("PostgreSQL: векторы holds", () => {
  const ctx = schema("vec");
  it("PgHoldLedger проходит векторы holds, как HoldLedger", async () => {
    await runHoldVectors(new PgHoldLedger(ctx.db));
  });
});

describe.skipIf(!DATABASE_URL)("PostgreSQL: удержания", () => {
  const ctx = schema("ops");
  const L = () => new PgHoldLedger(ctx.db);

  it("bigint у границы MAX_SAFE_INTEGER читается точно; сверх неё — ошибка, а не потеря точности", async () => {
    await L().openAccount("big", R(MAX));
    const h = await L().reserve("big", R(MAX - 5), "big-1");
    expect(h.amount).toBe(MAX - 5);
    expect(await L().available("big")).toEqual(R(5));
    // в обход пакета — значение вне безопасного диапазона
    await ctx.db.query("UPDATE core_hold_accounts SET limit_amount = limit_amount + 2 WHERE id = 'big'");
    expect(await code(L().account("big"))).toBe("RangeError");
  });

  it("CHECK в базе: зарезервировано больше лимита и валюта не по шаблону — отказ даже в обход пакета", async () => {
    await L().openAccount("chk", R(100));
    await expect(ctx.db.query("UPDATE core_hold_accounts SET reserved = 101 WHERE id = 'chk'")).rejects.toMatchObject({ code: "23514" });
    await expect(ctx.db.query("INSERT INTO core_hold_accounts (id, currency, limit_amount) VALUES ('x', 'rub', 1)")).rejects.toMatchObject({ code: "23514" });
  });

  it("частичное закрепление с освобождением остатка; повторное освобождение идемпотентно; счёт сходится", async () => {
    await L().openAccount("pc", { amount: 10_000, currency: "USDC" });
    const h = await L().reserve("pc", { amount: 7_000, currency: "USDC" }, "pc-1", null);
    const c = await L().commit(h.id, { amount: 2_500, currency: "USDC" }, true);
    expect(c).toMatchObject({ committed: 2_500, released: 4_500, state: "PARTIAL" });
    expect(await L().release(h.id)).toEqual(c);
    expect(await L().account("pc")).toMatchObject({ limit: 10_000, committed: 2_500, reserved: 0, version: 2 });
  });

  it("порядок кодов как у HoldLedger: неизвестное, закрытое, неверная сумма и валюта", async () => {
    expect(await code(L().get("HLD-999999"))).toBe("UNKNOWN_HOLD");
    expect(await code(L().get("hold-1"))).toBe("UNKNOWN_HOLD");
    expect(await code(L().reserve("nope", R(1), "n-1"))).toBe("UNKNOWN_ACCOUNT");
    await L().openAccount("ord", R(100));
    const h = await L().reserve("ord", R(10), "ord-1");
    expect(await code(L().commit(h.id, R(0)))).toBe("BAD_AMOUNT");
    expect(await code(L().commit(h.id, { amount: 1, currency: "rub" }))).toBe("BAD_CURRENCY");
    expect(await code(L().commit(h.id, R(11)))).toBe("BAD_AMOUNT");
    await L().release(h.id);
    expect(await code(L().commit(h.id, R(0)))).toBe("BAD_STATE");
    expect(await code(L().commit("HLD-999999", R(1)))).toBe("UNKNOWN_HOLD");
  });
});

/** Сверка счёта с удержаниями в базе: reserved — сумма открытых частей, committed — сумма закреплённых. */
async function balanced(db: pg.Pool, account: string) {
  const r = await db.query(
    `SELECT a.limit_amount::text AS lim, a.reserved::text AS reserved, a.committed::text AS committed,
            coalesce(sum(h.amount - h.committed - h.released), 0)::text AS open, coalesce(sum(h.committed), 0)::text AS held
     FROM core_hold_accounts a LEFT JOIN core_holds h ON h.account = a.id WHERE a.id = $1
     GROUP BY a.id`, [account]);
  const x = r.rows[0];
  expect(x.reserved, "reserved = сумма открытых частей").toBe(x.open);
  expect(x.committed, "committed = сумма закреплённых").toBe(x.held);
  expect(Number(x.reserved) + Number(x.committed)).toBeLessThanOrEqual(Number(x.lim));
}

// КТ2 (П2.2): одновременные обращения через пул на 20 подключений — каждый резерв на своём соединении.
describe.skipIf(!DATABASE_URL)("PostgreSQL: конкурентность удержаний (КТ2)", () => {
  const ctx = schema("race", 20);
  const L = () => new PgHoldLedger(ctx.db);

  it("20 одновременных резервов по 30 000 на счёт 500 000: успешных ровно 16, INSUFFICIENT — 4, остаток 20 000", async () => {
    await L().openAccount("race", R(500_000));
    const out = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => L().reserve("race", R(30_000), `race-${i}`)));
    const ok = out.filter((o) => o.status === "fulfilled");
    const codes = out.flatMap((o) => (o.status === "rejected" ? [(o.reason as HoldError).code ?? String(o.reason)] : []));
    expect(ok.length).toBe(16);
    expect(codes).toEqual(Array(4).fill("INSUFFICIENT"));
    expect(await L().available("race")).toEqual(R(20_000));
    expect(await L().account("race")).toMatchObject({ reserved: 480_000, version: 16 });
    await balanced(ctx.db, "race");
  });

  it("20 одновременных резервов с одним ref: одно удержание, 20 одинаковых ответов", async () => {
    await L().openAccount("same", R(100_000));
    const out = await Promise.all(Array.from({ length: 20 }, () => L().reserve("same", R(7_000), "same-ref")));
    expect(new Set(out.map((h) => h.id)).size).toBe(1);
    for (const h of out) expect(h).toEqual(out[0]);
    expect(await L().available("same")).toEqual(R(93_000));
    const n = await ctx.db.query("SELECT count(*)::int AS n FROM core_holds WHERE ref = 'same-ref'");
    expect(n.rows[0].n).toBe(1);
    await balanced(ctx.db, "same");
  });

  it("одновременные commit и release одного удержания: срабатывает одно, суммы сходятся", async () => {
    await L().openAccount("cr", R(1_000_000));
    const holds = await Promise.all(Array.from({ length: 10 }, (_, i) => L().reserve("cr", R(10_000), `cr-${i}`)));
    const out = await Promise.allSettled(holds.flatMap((h) => [L().commit(h.id, R(6_000)), L().release(h.id)]));
    for (const o of out) if (o.status === "rejected") expect((o.reason as HoldError).code).toBe("BAD_STATE");
    let committed = 0;
    for (const h of holds) {
      const x = await L().get(h.id);
      expect(x.amount - x.committed - x.released, `${h.id} закрыто`).toBe(0);
      // либо закрепление первым (6 000 + освобождено 4 000), либо освобождение первым (закрепления нет)
      expect([[6_000, 4_000, "PARTIAL"], [0, 10_000, "RELEASED"]]).toContainEqual([x.committed, x.released, x.state]);
      committed += x.committed;
    }
    expect(await L().account("cr")).toMatchObject({ reserved: 0, committed });
    await balanced(ctx.db, "cr");
  });

  it("одновременные резервы, закрепления и expire на одном счёте: инварианты счёта держатся", async () => {
    await L().openAccount("mix", R(200_000));
    const first = await Promise.all(Array.from({ length: 10 }, (_, i) => L().reserve("mix", R(15_000), `mix-a${i}`, i % 2 ? 1_000 : null)));
    await Promise.allSettled([
      ...first.map((h, i) => (i % 3 ? L().commit(h.id, R(5_000), i % 2 === 0) : L().release(h.id))),
      ...Array.from({ length: 10 }, (_, i) => L().reserve("mix", R(15_000), `mix-b${i}`)),
      L().expire(2_000), L().expire(2_000),
    ]);
    await balanced(ctx.db, "mix");
    const a = await L().account("mix");
    expect(a.limit - a.committed - a.reserved).toBeGreaterThanOrEqual(0);
  });
});
