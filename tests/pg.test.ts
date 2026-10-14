import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import {
  applyMigrations, migrationsDir, PgJournalStore, canonicalJson, AsyncHashChainJournal, chainGenesis, entryHash,
  type SqlClient, type JournalEntry,
} from "../src/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
const V = JSON.parse(readFileSync("vectors/vectors.json", "utf8"));
const fixed = () => "2026-10-08T00:00:00.000Z";
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

  it("векторы журнала хранятся побайтно: чтение возвращает те же записи, хэш пересчитывается в векторный (К2.2)", async () => {
    const s = new PgJournalStore(db, "vectors");
    for (const e of V.journal) await s.append(e);
    const rows = await s.all();
    expect(rows).toEqual(V.journal);
    for (const { hash, ...rest } of rows) expect(entryHash(rest)).toBe(hash);
    // векторы — безымянная цепочка (нули); под именем "vectors" начало другое — verify() отказывает (К6 п. 8)
    expect(await new AsyncHashChainJournal(s).verify()).toEqual({ ok: false, brokenAt: 1 });
  });

  it("журнал на PG: начало — chainGenesis, verify, extract; payload — канонический текст", async () => {
    const j = new AsyncHashChainJournal(new PgJournalStore(db, "pg-A"), fixed);
    const payload = { b: 1.5, a: "кириллица", nul: "\u0000", n: null, arr: [1, { z: 2, y: 3 }], big: 1e21 };
    const e1 = await j.append("k", "r1", payload);
    await j.append("k", "r2", { x: 2 }, "r1");
    expect(e1.prev_hash).toBe(chainGenesis("pg-A"));
    const read = await new PgJournalStore(db, "pg-A").all();
    expect(read[0]).toEqual(e1);
    expect(await j.verify()).toEqual({ ok: true });
    expect((await j.extract("r1")).map((e) => e.ref)).toEqual(["r1", "r2"]);
    const raw = await db.query("SELECT payload FROM core_journal WHERE chain = 'pg-A' AND seq = 1");
    expect(raw.rows[0].payload).toBe(canonicalJson(payload));
  });

  it("одновременные добавления на пуле: без развилки, seq подряд (К6 п. 7)", async () => {
    const j = new AsyncHashChainJournal(new PgJournalStore(db, "pg-race"), fixed, 30);
    const out = await Promise.all(Array.from({ length: 10 }, (_, i) => j.append("k", `r${i}`, { i })));
    expect(out.map((e) => e.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(await j.verify()).toEqual({ ok: true });
  });

  it("строки цепочки B под именем A в обход триггера — verify() отказывает (К2.2а)", async () => {
    const ja = new AsyncHashChainJournal(new PgJournalStore(db, "sw-A"), fixed);
    const jb = new AsyncHashChainJournal(new PgJournalStore(db, "sw-B"), fixed);
    await ja.append("k", "a1", { who: "A" });
    await jb.append("k", "b1", { who: "B" });
    await jb.append("k", "b2", { who: "B" });
    await db.query("ALTER TABLE core_journal DISABLE TRIGGER USER");
    try {
      await db.query("DELETE FROM core_journal WHERE chain = 'sw-A'");
      await db.query("UPDATE core_journal SET chain = 'sw-A' WHERE chain = 'sw-B'");
    } finally {
      await db.query("ALTER TABLE core_journal ENABLE TRIGGER USER");
    }
    expect(await ja.verify()).toEqual({ ok: false, brokenAt: 1 });
  });

  describe("подмена в обход триггера (К2.3)", () => {
    const bypass = async (...sql: string[]) => {
      await db.query("ALTER TABLE core_journal DISABLE TRIGGER USER");
      try { for (const q of sql) await db.query(q); } finally { await db.query("ALTER TABLE core_journal ENABLE TRIGGER USER"); }
    };
    const chain3 = async (name: string) => {
      const j = new AsyncHashChainJournal(new PgJournalStore(db, name), fixed);
      for (const r of ["r1", "r2", "r3"]) await j.append("k", r, { r });
      expect(await j.verify()).toEqual({ ok: true });
      return j;
    };

    it("изменённая запись", async () => {
      const j = await chain3("by-edit");
      await bypass(`UPDATE core_journal SET payload = '{"r":"x"}' WHERE chain = 'by-edit' AND seq = 2`);
      expect(await j.verify()).toEqual({ ok: false, brokenAt: 2 });
    });

    it("удалённая середина — ссылка следующей записи не сходится", async () => {
      const j = await chain3("by-mid");
      await bypass("DELETE FROM core_journal WHERE chain = 'by-mid' AND seq = 2");
      expect(await j.verify()).toEqual({ ok: false, brokenAt: 3 });
    });

    it("разрыв seq при верных ссылках и хэшах (запись мимо журнала: 1, 2, 4)", async () => {
      const s = new PgJournalStore(db, "by-gap");
      let prev = s.genesis;
      for (const seq of [1, 2, 4]) {
        const base = { seq, at: fixed(), kind: "k", ref: `r${seq}`, parent_ref: null, payload: { seq }, prev_hash: prev };
        const e: JournalEntry = { ...base, hash: entryHash(base) };
        await s.append(e);
        prev = e.hash;
      }
      expect(await new AsyncHashChainJournal(s).verify()).toEqual({ ok: false, brokenAt: 4 });
    });

    it("перестановка записей", async () => {
      const j = await chain3("by-swap");
      await bypass(
        "UPDATE core_journal SET seq = 100 WHERE chain = 'by-swap' AND seq = 2",
        "UPDATE core_journal SET seq = 2 WHERE chain = 'by-swap' AND seq = 3",
        "UPDATE core_journal SET seq = 3 WHERE chain = 'by-swap' AND seq = 100",
      );
      expect(await j.verify()).toEqual({ ok: false, brokenAt: 2 });
    });

    it("удалённый хвост: без якоря не виден, с якорем виден", async () => {
      const j = await chain3("by-tail");
      const last = (await new PgJournalStore(db, "by-tail").last())!;
      const anchor = { seq: last.seq, hash: last.hash };
      await bypass("DELETE FROM core_journal WHERE chain = 'by-tail' AND seq = 3");
      expect(await j.verify()).toEqual({ ok: true });
      expect(await j.verify(anchor)).toEqual({ ok: false, brokenAt: 3 });
    });

    it("рост после якоря — verify с якорем зелёный", async () => {
      const j = await chain3("by-grow");
      const last = (await new PgJournalStore(db, "by-grow").last())!;
      await j.append("k", "r4", { r: "r4" });
      await j.append("k", "r5", { r: "r5" });
      expect(await j.verify({ seq: last.seq, hash: last.hash })).toEqual({ ok: true });
    });
  });

  it("хэш — 64 строчных hex-символа", async () => {
    await expect(row("c", 1, H("0"), H("Z"))).rejects.toMatchObject({ code: "23514" });
  });
});
