// PgIdempotencyStore (К6 п. 11): тот же договор, что у памяти, на PostgreSQL; области scope не пересекаются.
// Без DATABASE_URL — пропуск; в CI пропуск ловит страж в tests/pg.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { applyMigrations, PgIdempotencyStore, IdempotencyInProgress } from "../src/index.js";
import { idempotencyContract } from "./idempotency-contract.js";
import { barrierClient } from "./pg-barrier.js";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("PostgreSQL: ключи идемпотентности", () => {
  const s = `i_${process.pid}_${Date.now()}`;
  let admin: pg.Pool;
  let db: pg.Pool;
  let n = 0;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${s}`);
    db = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${s}`, max: 12 });
    await applyMigrations(db);
  });
  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin?.end();
  });

  // каждый случай договора — в своей области: общий ключ "k" не пересекается
  idempotencyContract((opts) => new PgIdempotencyStore(db, `case-${++n}`, opts));

  // №21: тест договора «10 одновременных — fn один раз» на пуле не ловит проверку и захват двумя командами (SELECT, затем
  // INSERT): первый вызов успевает обе. Через барьер первые ответы — по одному на вызов — приходят вместе.
  it("10 одновременных run через барьер ответов: fn ровно один раз (проверка и захват — одна команда)", async () => {
    const n = 10;
    const b = barrierClient(db, n);
    const S = new PgIdempotencyStore<number>(b.client, "barrier");
    let calls = 0;
    const out = await Promise.allSettled(Array.from({ length: n }, () => S.run("race", { x: 1 }, async () => ++calls)));
    b.close();
    expect(b.left()).toBe(0);
    expect(calls).toBe(1);
    for (const r of out) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(IdempotencyInProgress);
      else expect(r.value.result).toBe(1);
    }
    expect(out.filter((r) => r.status === "fulfilled" && !r.value.replayed).length).toBe(1);
  });

  it("области scope не пересекаются; результат хранится канонической строкой JSON", async () => {
    const a = new PgIdempotencyStore<unknown>(db, "scope-a"), b = new PgIdempotencyStore<unknown>(db, "scope-b");
    await a.run("k", { x: 1 }, async () => ({ b: 2, a: "я" }));
    expect((await b.run("k", { x: 2 }, async () => 5)).replayed).toBe(false);
    const r = await db.query("SELECT result FROM core_idempotency WHERE scope = 'scope-a' AND key = 'k'");
    expect(r.rows[0].result).toBe('{"a":"я","b":2}');
  });
});
