import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  AsyncHashChainJournal, AsyncMemoryJournalStore, JournalAppendConflict, chainGenesis, entryHash, GENESIS_HASH,
  type AsyncJournalStore, type JournalEntry,
} from "../src/index.js";

const V = JSON.parse(readFileSync("vectors/vectors.json", "utf8"));
const fixed = () => "2026-10-08T00:00:00.000Z";
const rowsOf = (genesis: string, rows: readonly JournalEntry[]): AsyncJournalStore => ({
  genesis, last: async () => rows[rows.length - 1], append: async () => {}, all: async () => rows,
});

describe("асинхронный журнал (К6 п. 4)", () => {
  it("безымянная цепочка совпадает с векторами журнала", async () => {
    const j = new AsyncHashChainJournal(new AsyncMemoryJournalStore(), fixed);
    const e1 = await j.append("mandate", "MND-1", { amount_limit: 500000 });
    const e2 = await j.append("mandate", "MND-2", { amount_limit: 189000 }, "MND-1");
    expect([e1, e2]).toEqual(V.journal);
    expect(await j.verify()).toEqual({ ok: true });
    expect((await j.extract("MND-1")).map((e) => e.ref)).toEqual(["MND-1", "MND-2"]);
  });

  it("начало именованной цепочки — sha256(\"core_journal:\" + имя) в UTF-8 (К6 п. 8)", () => {
    const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
    expect(chainGenesis("A")).toBe(sha("core_journal:A"));
    expect(chainGenesis("журнал-1")).toBe(sha("core_journal:журнал-1"));
    expect(chainGenesis("A")).not.toBe(GENESIS_HASH);
  });

  it("начало цепочки совпадает с векторами journal_chain_genesis; UTF-8 без нормализации — NFC и NFD различаются (К2.2в)", () => {
    const G = V.journal_chain_genesis as { chain: string; chain_utf8_hex: string; genesis: string }[];
    expect(G.length).toBeGreaterThanOrEqual(4);
    for (const g of G) {
      expect(Buffer.from(g.chain, "utf8").toString("hex")).toBe(g.chain_utf8_hex);
      expect(chainGenesis(g.chain)).toBe(g.genesis);
    }
    const nfc = G.find((g) => g.chain === "\u0439")!;
    const nfd = G.find((g) => g.chain === "\u0438\u0306")!;
    expect(nfc.chain.normalize("NFC")).toBe(nfd.chain.normalize("NFC"));
    expect(nfc.genesis).not.toBe(nfd.genesis);
  });

  it("строки цепочки B под именем A — verify() отказывает на первой записи (К2.2а)", async () => {
    const b = new AsyncMemoryJournalStore(chainGenesis("B"));
    const jb = new AsyncHashChainJournal(b, fixed);
    await jb.append("k", "r1", { x: 1 });
    await jb.append("k", "r2", { x: 2 });
    expect(await jb.verify()).toEqual({ ok: true });
    const asA = new AsyncHashChainJournal(rowsOf(chainGenesis("A"), await b.all()));
    expect(await asA.verify()).toEqual({ ok: false, brokenAt: 1 });
  });

  it("разрыв seq и изменённая запись обнаруживаются", async () => {
    const s = new AsyncMemoryJournalStore();
    const j = new AsyncHashChainJournal(s, fixed);
    for (const r of ["r1", "r2", "r3"]) await j.append("k", r, { r });
    const rows = await s.all();
    expect(await new AsyncHashChainJournal(rowsOf(GENESIS_HASH, [rows[0]!, rows[2]!])).verify()).toEqual({ ok: false, brokenAt: 3 });
    expect(await new AsyncHashChainJournal(rowsOf(GENESIS_HASH, [rows[0]!, { ...rows[1]!, payload: { r: "x" } }, rows[2]!])).verify()).toEqual({ ok: false, brokenAt: 2 });
  });

  it("разрыв seq при верных ссылках и хэшах (1, 2, 4) — ловит только проверка seq (К2.3)", async () => {
    const rows: JournalEntry[] = [];
    let prev = GENESIS_HASH;
    for (const seq of [1, 2, 4]) {
      const base = { seq, at: fixed(), kind: "k", ref: `r${seq}`, parent_ref: null, payload: { seq }, prev_hash: prev };
      const e = { ...base, hash: entryHash(base) };
      rows.push(e);
      prev = e.hash;
    }
    expect(await new AsyncHashChainJournal(rowsOf(GENESIS_HASH, rows)).verify()).toEqual({ ok: false, brokenAt: 4 });
  });

  it("якорь {seq, hash}: удалённый хвост виден только с якорем; рост после якоря — не ошибка (К2.3)", async () => {
    const s = new AsyncMemoryJournalStore();
    const j = new AsyncHashChainJournal(s, fixed);
    for (const r of ["r1", "r2", "r3"]) await j.append("k", r, { r });
    const rows = await s.all();
    const anchor = { seq: 3, hash: rows[2]!.hash };
    expect(await j.verify(anchor)).toEqual({ ok: true });
    const cut = new AsyncHashChainJournal(rowsOf(GENESIS_HASH, rows.slice(0, 2)));
    expect(await cut.verify()).toEqual({ ok: true });
    expect(await cut.verify(anchor)).toEqual({ ok: false, brokenAt: 3 });
    expect(await j.verify({ seq: 2, hash: "f".repeat(64) })).toEqual({ ok: false, brokenAt: 2 });
    await j.append("k", "r4", { r: "r4" });
    expect(await j.verify(anchor)).toEqual({ ok: true });
  });

  it("одновременные добавления: конфликт — повтор, цепочка без развилки (К6 п. 7)", async () => {
    const s = new AsyncMemoryJournalStore(chainGenesis("A"));
    const j = new AsyncHashChainJournal(s, fixed, 25);
    const out = await Promise.all(Array.from({ length: 20 }, (_, i) => j.append("k", `r${i}`, { i })));
    expect(out.map((e) => e.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await j.verify()).toEqual({ ok: true });
  });

  it("конфликт сверх maxAttempts — JournalAppendConflict вызывающему; другие ошибки не повторяются", async () => {
    let calls = 0;
    const always: AsyncJournalStore = { last: async () => undefined, all: async () => [], append: async (e) => { calls++; throw new JournalAppendConflict(e.seq); } };
    await expect(new AsyncHashChainJournal(always, fixed, 3).append("k", "r", {})).rejects.toBeInstanceOf(JournalAppendConflict);
    expect(calls).toBe(3);
    calls = 0;
    const broken: AsyncJournalStore = { last: async () => undefined, all: async () => [], append: async () => { calls++; throw new Error("сеть"); } };
    await expect(new AsyncHashChainJournal(broken, fixed, 3).append("k", "r", {})).rejects.toThrow("сеть");
    expect(calls).toBe(1);
  });
});
