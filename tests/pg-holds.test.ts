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
function schema(name: string) {
  const s = `h_${name}_${process.pid}_${Date.now()}`;
  const ctx = { admin: undefined as pg.Pool | undefined, db: undefined as unknown as pg.Pool };
  beforeAll(async () => {
    ctx.admin = new pg.Pool({ connectionString: DATABASE_URL });
    await ctx.admin.query(`CREATE SCHEMA ${s}`);
    ctx.db = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${s}`, max: 25 });
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
