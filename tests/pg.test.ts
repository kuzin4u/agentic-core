import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { applyMigrations, migrationsDir, type SqlClient } from "../src/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
const H = (c: string) => c.repeat(64);

// pg.Pool и pg.Client подходят как SqlClient без обёртки (проверка типов, К6 п. 1)
const _pool: (p: pg.Pool) => SqlClient = (p) => p;
const _client: (c: pg.Client) => SqlClient = (c) => c;
void _pool; void _client;

describe("applyMigrations без базы", () => {
  const fake = () => {
    const seen: string[] = [];
    const names = new Set<string>();
    const client: SqlClient = {
      async query<R>(text: string) {
        seen.push(text);
        const m = /INSERT INTO core_migrations \(name\) VALUES \('([^']+)'\)/.exec(text);
        if (m) names.add(m[1]!);
        if (text.startsWith("SELECT name FROM core_migrations")) return { rows: [...names].map((name) => ({ name })) as R[] };
        return { rows: [] };
      },
    };
    return { client, seen };
  };

  it("применяет файлы по порядку номеров, повторный запуск ничего не применяет", async () => {
    const dir = mkdtempSync(join(tmpdir(), "core-sql-"));
    writeFileSync(join(dir, "002_b.sql"), "SELECT 2;");
    writeFileSync(join(dir, "001_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "readme.txt"), "не миграция");
    writeFileSync(join(dir, "003_X'; DROP.sql"), "SELECT 3;");
    const { client, seen } = fake();
    expect(await applyMigrations(client, dir)).toEqual(["001_a.sql", "002_b.sql"]);
    expect(seen.filter((s) => s.startsWith("BEGIN")).map((s) => s.includes("SELECT 1;") ? 1 : 2)).toEqual([1, 2]);
    expect(await applyMigrations(client, dir)).toEqual([]);
  });

  it("каталог sql/ пакета найден, в нём миграция журнала", () => {
    expect(migrationsDir()).toMatch(/sql$/);
  });
});

describe.skipIf(!DATABASE_URL)("PostgreSQL: миграция журнала и запрет изменений", () => {
  const schema = `t_${process.pid}_${Date.now()}`;
  let admin: pg.Pool;
  let db: pg.Pool;
  const row = (chain: string, seq: number, prev: string, hash: string) =>
    db.query(
      "INSERT INTO core_journal (chain, seq, at, kind, ref, parent_ref, payload, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [chain, seq, "2026-10-14T00:00:00Z", "k", `r${seq}`, null, "{}", prev, hash],
    );

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
  });
  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("миграции применяются один раз", async () => {
    expect(await applyMigrations(db)).toEqual(["001_journal.sql"]);
    expect(await applyMigrations(db)).toEqual([]);
    const t = await db.query("SELECT tgname FROM pg_trigger WHERE tgrelid = 'core_journal'::regclass AND NOT tgisinternal ORDER BY tgname");
    expect(t.rows.map((r) => r.tgname)).toEqual(["core_journal_no_truncate", "core_journal_no_update_delete"]);
  });

  it("добавление проходит; UPDATE, DELETE, TRUNCATE отклоняются триггером", async () => {
    await row("a", 1, H("0"), H("1"));
    await row("a", 2, H("1"), H("2"));
    await expect(db.query("UPDATE core_journal SET payload = '{\"x\":1}' WHERE chain = 'a' AND seq = 1")).rejects.toMatchObject({ code: "23001" });
    await expect(db.query("DELETE FROM core_journal WHERE chain = 'a' AND seq = 2")).rejects.toMatchObject({ code: "23001" });
    await expect(db.query("TRUNCATE core_journal")).rejects.toMatchObject({ code: "23001" });
    const n = await db.query("SELECT count(*)::int AS n FROM core_journal WHERE chain = 'a'");
    expect(n.rows[0].n).toBe(2);
  });

  it("развилка невозможна: повтор (chain, seq) и повтор prev_hash в цепочке отклоняются", async () => {
    await expect(row("a", 2, H("1"), H("3"))).rejects.toMatchObject({ code: "23505" });
    await expect(row("a", 3, H("1"), H("4"))).rejects.toMatchObject({ code: "23505" });
    await row("b", 1, H("0"), H("1")); // другая цепочка — свои seq и prev_hash
  });

  it("хэш — 64 строчных hex-символа", async () => {
    await expect(row("c", 1, H("0"), H("Z"))).rejects.toMatchObject({ code: "23514" });
  });
});
