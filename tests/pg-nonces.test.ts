// PgNonceStore (К6 п. 12): тот же договор, что у памяти, на PostgreSQL; области scope не пересекаются.
// Без DATABASE_URL — пропуск; в CI пропуск ловит страж в tests/pg.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { applyMigrations, PgNonceStore, type SqlClient } from "../src/index.js";
import { nonceContract } from "./nonce-contract.js";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("PostgreSQL: nonce", () => {
  const s = `n_${process.pid}_${Date.now()}`;
  let admin: pg.Pool;
  let db: pg.Pool;
  let n = 0;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${s}`);
    db = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${s}`, max: 20 });
    await applyMigrations(db);
  });
  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin?.end();
  });

  nonceContract((opts) => new PgNonceStore(db, `case-${++n}`, opts));

  // Барьер ответов (П2.1): первые n ответов базы отдаются вызывающим только когда пришли все n. Если seen — две команды
  // (SELECT, затем INSERT), все SELECT увидят пустую таблицу раньше любого INSERT, и «новым» окажется каждый вызов.
  // Тест договора на пуле этого не ловит: соединения открываются по одному, и первый вызов успевает обе команды.
  it("20 одновременных seen через барьер ответов: false ровно один раз (проверка и запись — одна команда)", async () => {
    const n = 20;
    let left = n, open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const barrier: SqlClient = {
      async query(text, params) {
        const r = await db.query(text, params as unknown[]);
        if (left > 0 && --left === 0) open();
        await gate;
        return r;
      },
    };
    const N = new PgNonceStore(barrier, "barrier", { retainMs: 600_000 });
    const out = await Promise.all(Array.from({ length: n }, () => N.seen("race")));
    expect(out.filter((x) => !x).length).toBe(1);
  });

  it("области scope не пересекаются; purge чистит только свою", async () => {
    let t = 1_000_000;
    const a = new PgNonceStore(db, "scope-a", { retainMs: 1_000, now: () => t }), b = new PgNonceStore(db, "scope-b", { retainMs: 1_000, now: () => t });
    expect(await a.seen("x")).toBe(false);
    expect(await b.seen("x")).toBe(false);
    t += 2_000;
    expect(await a.purge()).toBe(1);
    expect(await b.seen("x")).toBe(true);
  });
});
