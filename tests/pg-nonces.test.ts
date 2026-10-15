// PgNonceStore (К6 п. 12): тот же договор, что у памяти, на PostgreSQL; области scope не пересекаются.
// Без DATABASE_URL — пропуск; в CI пропуск ловит страж в tests/pg.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { applyMigrations, PgNonceStore } from "../src/index.js";
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
