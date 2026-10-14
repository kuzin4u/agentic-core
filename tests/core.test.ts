import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import {
  canonicalJson, sha256Hex, HashChainJournal, MemoryJournalStore, HoldLedger, HoldError,
  IdempotencyStore, IdempotencyConflict, newEd25519Signer, signRequest, verifyRequest, ed25519Verifier,
  Outbox, Inbox, splitByWeights,
} from "../src/index.js";
import { decodePoint, timesEight, isIdentity, isWeakEd25519 } from "../src/ed25519.js";

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

describe("слабые открытые ключи Ed25519 (A2 п. 5.1, расхождение 12)", () => {
  const spkiOf = (hex: string) => Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(hex, "hex")]).toString("base64");
  // Подпись «R = точка ключа, S = 0»: для нейтрали верна для любого сообщения.
  const forgedFor = (hex: string) => Buffer.concat([Buffer.from(hex, "hex"), Buffer.alloc(32)]);
  const MSG = Buffer.from("любое обращение");
  // Восемь точек малого порядка — независимый список (как блок-лист libsodium), не из кода ядра.
  const SMALL_ORDER = [
    "0100000000000000000000000000000000000000000000000000000000000000",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000080",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
  ];
  // y = p + 3 — запись точки большого порядка (y = 3), её ловит только проверка y < p.
  const Y_P_PLUS_3 = "f0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f";
  const NON_CANONICAL = [
    "0100000000000000000000000000000000000000000000000000000000000080", // нейтраль, x = 0 со знаковым битом
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", // y = −1, x = 0 со знаковым битом
    "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // y = p + 1
    "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // y = p
    Y_P_PLUS_3,
  ];
  const OFF_CURVE = `02${"00".repeat(31)}`; // y = 2: у (y² − 1)/(d·y² + 1) нет квадратного корня

  it("почему: голый crypto.verify принимает подделку с ключом-нейтралью, ed25519Verifier — нет", () => {
    const pub = createPublicKey({ key: Buffer.from(spkiOf(SMALL_ORDER[0]!), "base64"), format: "der", type: "spki" });
    expect(cryptoVerify(null, MSG, pub, forgedFor(SMALL_ORDER[0]!))).toBe(true);
    expect(ed25519Verifier.verify("ed25519", spkiOf(SMALL_ORDER[0]!), MSG, forgedFor(SMALL_ORDER[0]!))).toBe(false);
  });
  it.each(SMALL_ORDER)("точка малого порядка %s — отказ", (hex) => {
    expect(ed25519Verifier.verify("ed25519", spkiOf(hex), MSG, forgedFor(hex))).toBe(false);
    expect(ed25519Verifier.verify("ed25519", spkiOf(hex), MSG, forgedFor(SMALL_ORDER[0]!))).toBe(false);
  });
  it.each(NON_CANONICAL)("неканоническая запись %s — отказ", (hex) => {
    expect(ed25519Verifier.verify("ed25519", spkiOf(hex), MSG, forgedFor(SMALL_ORDER[0]!))).toBe(false);
  });
  it("y = p + 3 отвергается, а каноническая запись той же точки (y = 3) — обычный ключ", () => {
    const y3 = `03${"00".repeat(31)}`;
    const k3 = createPublicKey({ key: Buffer.from(spkiOf(y3), "base64"), format: "der", type: "spki" });
    expect(k3.asymmetricKeyType).toBe("ed25519");
    expect(ed25519Verifier.verify("ed25519", spkiOf(Y_P_PLUS_3), MSG, forgedFor(SMALL_ORDER[0]!))).toBe(false);
    // y = 3 не слабая: отказ подделке даёт сама проверка подписи, а не разбор ключа — подпись верна только с закрытым ключом.
    expect(ed25519Verifier.verify("ed25519", spkiOf(y3), MSG, forgedFor(SMALL_ORDER[0]!))).toBe(false);
  });
  it("арифметика: [8]·B ≠ нейтраль для базовой точки, [8]·T = нейтраль для каждой точки малого порядка", () => {
    // Базовая точка B (RFC 8032 §5.1): y = 4/5, x чётный — запись 0x5866…66.
    const B = Buffer.from(`58${"66".repeat(31)}`, "hex");
    const b = decodePoint(B)!;
    expect(b[0]).toBe(15112221349535400772501151409588531511454012693041857206046113283949847762202n);
    expect(isIdentity(timesEight(b))).toBe(false);
    expect(isWeakEd25519(B)).toBe(false);
    for (const hex of SMALL_ORDER) {
      const t = decodePoint(Buffer.from(hex, "hex"));
      expect(t).not.toBeNull();
      expect(isIdentity(timesEight(t!))).toBe(true);
    }
    expect(decodePoint(Buffer.from(OFF_CURVE, "hex"))).toBeNull();
  });
  it("точка не на кривой — отказ, без исключения", () => {
    expect(ed25519Verifier.verify("ed25519", spkiOf(OFF_CURVE), MSG, forgedFor(SMALL_ORDER[0]!))).toBe(false);
  });
  it("битый DER, чужой заголовок, неканонический base64 — отказ, без исключения", () => {
    const { signer, publicKey } = newEd25519Signer("k-w");
    const sig = signer.sign(MSG);
    expect(ed25519Verifier.verify("ed25519", publicKey, MSG, sig)).toBe(true);
    const der = Buffer.from(publicKey, "base64");
    expect(ed25519Verifier.verify("ed25519", der.subarray(0, 40).toString("base64"), MSG, sig)).toBe(false);
    expect(ed25519Verifier.verify("ed25519", Buffer.concat([der, Buffer.alloc(1)]).toString("base64"), MSG, sig)).toBe(false);
    const x25519 = Buffer.from(der); x25519[8] = 0x6e; // OID 1.3.101.110 (X25519) вместо 1.3.101.112
    expect(ed25519Verifier.verify("ed25519", x25519.toString("base64"), MSG, sig)).toBe(false);
    expect(ed25519Verifier.verify("ed25519", der.toString("base64url"), MSG, sig)).toBe(false);
    expect(ed25519Verifier.verify("ed25519", publicKey.slice(0, 30) + "\n" + publicKey.slice(30), MSG, sig)).toBe(false);
    expect(ed25519Verifier.verify("ed25519", "не base64", MSG, sig)).toBe(false);
  });
  it("через verifyRequest: обращение, «подписанное» ключом-нейтралью, — SIGNATURE_INVALID", () => {
    const forger = { kid: "k-0", alg: "ed25519", sign: () => forgedFor(SMALL_ORDER[0]!) };
    const s = signRequest({ method: "GET", path: "/pao/v1/agent", query: "", body: "",
      headers: { "x-agent-code": "nspk:agent:x:v1", "x-timestamp": "2026-10-08T08:41:12Z", "x-nonce": "w1" } }, forger);
    const lookup = () => ({ alg: "ed25519", publicKey: spkiOf(SMALL_ORDER[0]!), status: "ACTIVE" as const });
    expect(verifyRequest(s, lookup, { now: Date.parse("2026-10-08T08:41:12Z"), skewSec: 300, seenNonce: () => false }))
      .toEqual({ ok: false, code: "SIGNATURE_INVALID" });
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

// ВРЕМЕННО (П3а): подставная поломка «падение только на Node 20» — проверка итоговой test; отменяется git revert.
it("ВРЕМЕННО: поломка только на Node 20", () => {
  expect(process.versions.node.startsWith("20."), "подставная поломка П3а").toBe(false);
});
