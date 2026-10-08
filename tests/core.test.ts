import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  canonicalJson, sha256Hex, HashChainJournal, MemoryJournalStore, HoldLedger, HoldError,
  IdempotencyStore, IdempotencyConflict, newEd25519Signer, signRequest, verifyRequest,
  Outbox, Inbox, splitByWeights,
} from "../src/index.js";

const V = JSON.parse(readFileSync("vectors/vectors.json", "utf8"));

describe("canonical", () => {
  it("совпадает с тестовыми векторами", () => {
    for (const v of V.canonical) {
      expect(canonicalJson(v.input)).toBe(v.canonical);
      expect(sha256Hex(canonicalJson(v.input))).toBe(v.sha256);
    }
  });
});

describe("журнал с хэш-цепочкой", () => {
  const fixed = () => "2026-10-08T00:00:00.000Z";
  it("цепочка совпадает с векторами и проверяется", () => {
    const j = new HashChainJournal(new MemoryJournalStore(), fixed);
    const e1 = j.append("mandate", "MND-1", { amount_limit: 500000 });
    const e2 = j.append("mandate", "MND-2", { amount_limit: 189000 }, "MND-1");
    expect(e1.hash).toBe(V.journal[0].hash);
    expect(e2.hash).toBe(V.journal[1].hash);
    expect(j.verify()).toEqual({ ok: true });
    expect(j.extract("MND-1").map((e) => e.ref)).toEqual(["MND-1", "MND-2"]);
  });
  it("подмена задним числом обнаруживается", () => {
    const store = new MemoryJournalStore();
    const j = new HashChainJournal(store, fixed);
    j.append("mandate", "MND-1", { amount_limit: 500000 });
    j.append("mandate", "MND-2", { amount_limit: 189000 });
    (store.all() as any)[0] = { ...store.all()[0], payload: { amount_limit: 9999999 } };
    expect(j.verify()).toEqual({ ok: false, brokenAt: 1 });
  });
});

describe("удержания: резерв → закрепление → освобождение", () => {
  it("сценарий из векторов", () => {
    const L = new HoldLedger();
    for (const step of V.holds) {
      const [op, ...args] = step.op;
      let ids: Record<string, string> = (globalThis as any).__ids ??= {};
      try {
        if (op === "open") L.openAccount(args[0], args[1]);
        if (op === "reserve") ids[args[2]] = L.reserve(args[0], args[1], args[2], args[3] ?? null).id;
        if (op === "commit") L.commit(ids[args[0]]!, args[1], args[2] ?? false);
        if (op === "release") L.release(ids[args[0]]!);
        if (op === "expire") L.expire(args[0]);
        expect(step.error ?? null).toBeNull();
      } catch (e) {
        expect((e as HoldError).code).toBe(step.error);
      }
      expect(L.available("MND-1")).toBe(step.available);
    }
  });
  it("конкурентные резервы не превышают лимит ни на копейку", () => {
    const L = new HoldLedger(); L.openAccount("A", 300000);
    let ok = 0;
    for (let i = 0; i < 20; i++) { try { L.reserve("A", 100000, `op-${i}`); ok++; } catch { /* INSUFFICIENT */ } }
    expect(ok).toBe(3);
    expect(L.available("A")).toBe(0);
  });
  it("повтор резерва с тем же ref идемпотентен, с другой суммой — конфликт", () => {
    const L = new HoldLedger(); L.openAccount("A", 1000);
    const h1 = L.reserve("A", 400, "r1"); const h2 = L.reserve("A", 400, "r1");
    expect(h2.id).toBe(h1.id); expect(L.available("A")).toBe(600);
    expect(() => L.reserve("A", 500, "r1")).toThrowError(/REF_CONFLICT/);
  });
});

describe("идемпотентность", () => {
  it("тот же ключ и тело — повтор; другое тело — конфликт", () => {
    const S = new IdempotencyStore<number>(); let calls = 0;
    expect(S.run("k", { a: 1 }, () => ++calls)).toEqual({ result: 1, replayed: false });
    expect(S.run("k", { a: 1 }, () => ++calls)).toEqual({ result: 1, replayed: true });
    expect(() => S.run("k", { a: 2 }, () => ++calls)).toThrow(IdempotencyConflict);
    expect(calls).toBe(1);
  });
});

describe("подпись обращений", () => {
  const { signer, publicKey } = newEd25519Signer("k-1");
  const now = Date.parse("2026-10-08T08:41:12Z");
  const req = { method: "POST", path: "/pao/v1/credentials", query: "", body: '{"a":1}',
    headers: { "x-agent-code": "nspk:agent:buyref-01:v3", "x-timestamp": "2026-10-08T08:41:12Z", "x-nonce": "n1" } };
  const nonces = new Set<string>();
  const seen = (n: string) => { const s = nonces.has(n); nonces.add(n); return s; };
  const key = (status: "ACTIVE" | "REVOKED") => () => ({ alg: "ed25519", publicKey, status });
  it("подписанное проходит, повтор nonce — нет", () => {
    const s = signRequest(req, signer);
    expect(verifyRequest(s, key("ACTIVE"), { now, skewSec: 300, seenNonce: seen })).toEqual({ ok: true, kid: "k-1" });
    expect(verifyRequest(s, key("ACTIVE"), { now, skewSec: 300, seenNonce: seen }).ok).toBe(false);
  });
  it("подмена тела, просрочка и отозванный ключ отклоняются", () => {
    const s = signRequest({ ...req, headers: { ...req.headers, "x-nonce": "n2" } }, signer);
    expect(verifyRequest({ ...s, body: '{"a":2}' }, key("ACTIVE"), { now, skewSec: 300, seenNonce: () => false }).ok).toBe(false);
    expect(verifyRequest(s, key("ACTIVE"), { now: now + 3600_000, skewSec: 300, seenNonce: () => false }).ok).toBe(false);
    expect(verifyRequest(s, key("REVOKED"), { now, skewSec: 300, seenNonce: () => false })).toEqual({ ok: false, code: "AGENT_KEY_REVOKED" });
  });
});

describe("события", () => {
  it("повтор доставки до успеха; получатель обрабатывает один раз", async () => {
    const O = new Outbox(8); const I = new Inbox(); let fails = 2, handled = 0;
    O.enqueue({ event_id: "e1", type: "operation.settled", at: "", data: {} }, 0);
    const send = async (e: any) => { if (fails-- > 0) return false; I.handle(e, () => handled++); return true; };
    let t = 0;
    for (let i = 0; i < 5 && O.pending(); i++) { await O.flush(t, send); t += 60_000; }
    expect(O.pending()).toBe(0);
    expect(I.handle({ event_id: "e1", type: "", at: "", data: {} }, () => handled++)).toBe(false);
    expect(handled).toBe(1);
  });
});

describe("деньги", () => {
  it("распределение без потери копейки", () => {
    const parts = splitByWeights(100001, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100001);
  });
});
