// К25 п. 3–5: проверка обращения агента у продавца — каталог через порт, кэш, перечитывание, подпись по байтам, nonce.
import { describe, expect, it } from "vitest";
import { sign } from "node:crypto";
import { AsyncMemoryNonceStore, signRequest, type HttpLike, type Signer } from "../src/index.js";
import { MerchantAgentVerifier, type AgentKeySource } from "../src/merchant/index.js";
import { agentKey } from "./merchant-keys.js";

const T0 = 1_800_000_000_000;
const A = "nspk:agent:a:v1";
const B = "nspk:agent:b:v1";

type Key = ReturnType<typeof agentKey>;
const signerOf = (k: Key): Signer => ({ kid: k.jwk.kid, alg: "ed25519", sign: (d) => sign(null, d, k.privateKey) });

let seq = 0;
function call(k: Key, o: { agent?: string; body?: string | Uint8Array; at?: number; nonce?: string } = {}): HttpLike {
  const req: HttpLike = {
    method: "POST",
    path: "/orders/1/payment",
    query: "",
    headers: {
      "x-agent-code": o.agent ?? k.jwk.agent_code,
      "x-timestamp": new Date(o.at ?? T0).toISOString(),
      "x-nonce": o.nonce ?? `n-${++seq}`,
    },
    body: o.body ?? new Uint8Array([123, 125]),
  };
  return signRequest(req, signerOf(k));
}

function stand(keys: () => unknown[], o: { now?: () => number; maxAgeSec?: number; fail?: () => boolean } = {}) {
  let t = T0;
  const port = { calls: 0 };
  const source: AgentKeySource = async () => {
    port.calls++;
    if (o.fail?.()) throw new Error("каталог недоступен");
    return { body: { keys: keys() }, ...(o.maxAgeSec !== undefined ? { maxAgeSec: o.maxAgeSec } : {}) };
  };
  const now = o.now ?? (() => t);
  const v = new MerchantAgentVerifier(source, {
    skewSec: 30,
    nonces: new AsyncMemoryNonceStore({ retainMs: 60_000, skewSec: 30, now }),
    defaultMaxAgeSec: 300,
    refetchMinSec: 30,
    now,
  });
  return { v, port, tick: (ms: number) => { t += ms; }, at: () => t };
}

describe("MerchantAgentVerifier — порядок MERCHANT-API §3", () => {
  it("верное обращение — agent; второе с тем же nonce — SIGNATURE_INVALID", async () => {
    const k = agentKey(A);
    const { v } = stand(() => [k.jwk]);
    const req = call(k, { nonce: "same" });
    expect(await v.verify(req)).toEqual({ kind: "agent", agentCode: A, kid: k.jwk.kid });
    expect(await v.verify(req)).toEqual({ kind: "refused", code: "SIGNATURE_INVALID" });
  });

  it("ни одного заголовка агента — unsigned, каталог не читается", async () => {
    const { v, port } = stand(() => []);
    expect(await v.verify({ method: "GET", path: "/", headers: { accept: "text/html" } })).toEqual({ kind: "unsigned" });
    expect(port.calls).toBe(0);
  });

  it("поправка 2: хоть один заголовок агента без полной подписи — SIGNATURE_INVALID, не unsigned", async () => {
    const k = agentKey(A);
    const { v, port } = stand(() => [k.jwk]);
    const full = call(k).headers;
    const only = (names: string[]) => Object.fromEntries(names.map((n) => [n, full[n]!]));
    for (const headers of [
      only(["x-agent-code"]),
      { "X-Agent-Code": A },
      only(["signature"]),
      only(["signature-input"]),
      only(["content-digest"]),
      only(["x-agent-code", "signature-input", "content-digest"]),            // нет signature
      only(["signature", "signature-input", "content-digest"]),                // нет x-agent-code
      { ...full, "signature-input": full["signature-input"]!.replace(/;keyid="[^"]+"/, "") }, // нет keyid
    ]) {
      expect(await v.verify({ method: "POST", path: "/", headers, body: new Uint8Array([123, 125]) })).toEqual({ kind: "refused", code: "SIGNATURE_INVALID" });
    }
    expect(port.calls).toBe(0);
  });

  it("kid нет в каталоге — KEY_UNKNOWN; agent_code ключа ≠ x-agent-code — AGENT_MISMATCH", async () => {
    const k = agentKey(A);
    const stranger = agentKey(A);
    const { v } = stand(() => [k.jwk]);
    expect(await v.verify(call(stranger))).toEqual({ kind: "refused", code: "KEY_UNKNOWN" });
    expect(await v.verify(call(k, { agent: B }))).toEqual({ kind: "refused", code: "AGENT_MISMATCH" });
  });

  it("срок ключа: раньше nbf и не раньше exp — KEY_EXPIRED", async () => {
    const early = agentKey(A, T0 / 1000 + 1, T0 / 1000 + 100);
    const late = agentKey(A, T0 / 1000 - 100, T0 / 1000);
    const ok = agentKey(A, T0 / 1000, T0 / 1000 + 1);
    const { v } = stand(() => [early.jwk, late.jwk, ok.jwk]);
    expect(await v.verify(call(early))).toEqual({ kind: "refused", code: "KEY_EXPIRED" });
    expect(await v.verify(call(late))).toEqual({ kind: "refused", code: "KEY_EXPIRED" });
    expect((await v.verify(call(ok))).kind).toBe("agent");
  });

  it("подпись: чужой ключ под kid, x-timestamp вне окна, подмена тела — SIGNATURE_INVALID", async () => {
    const k = agentKey(A);
    const other = agentKey(A);
    const { v } = stand(() => [k.jwk]);
    const forged = signRequest({ method: "POST", path: "/", query: "", headers: { "x-agent-code": A, "x-timestamp": new Date(T0).toISOString(), "x-nonce": "f" }, body: "{}" },
      { kid: k.jwk.kid, alg: "ed25519", sign: (d) => sign(null, d, other.privateKey) });
    expect(await v.verify(forged)).toEqual({ kind: "refused", code: "SIGNATURE_INVALID" });
    expect(await v.verify(call(k, { at: T0 - 31_000 }))).toEqual({ kind: "refused", code: "SIGNATURE_INVALID" });
    const req = call(k);
    expect(await v.verify({ ...req, body: new Uint8Array([123, 32, 125]) })).toEqual({ kind: "refused", code: "SIGNATURE_INVALID" });
  });

  it("тело байтами (К22): не UTF-8 проходит подпись по байтам; срез subarray — digest представления", async () => {
    const k = agentKey(A);
    const { v } = stand(() => [k.jwk]);
    expect((await v.verify(call(k, { body: new Uint8Array([0xff, 0xfe, 0x00]) }))).kind).toBe("agent");
    const big = Buffer.from("xx{}yy");
    expect((await v.verify(call(k, { body: big.subarray(2, 4) }))).kind).toBe("agent");
  });

  it("body не задан — проверка как у пустого тела: digest непустого тела не проходит", async () => {
    const k = agentKey(A);
    const { v } = stand(() => [k.jwk]);
    const { body: _b, ...noBody } = call(k, { body: "{}" });
    expect(await v.verify(noBody)).toEqual({ kind: "refused", code: "SIGNATURE_INVALID" });
    const { body: _e, ...empty } = call(k, { body: "" });
    expect((await v.verify(empty)).kind).toBe("agent");
  });

  it("nonce — у каждого агента своя область", async () => {
    const a = agentKey(A);
    const b = agentKey(B);
    const { v } = stand(() => [a.jwk, b.jwk]);
    expect((await v.verify(call(a, { nonce: "n" }))).kind).toBe("agent");
    expect((await v.verify(call(b, { nonce: "n" }))).kind).toBe("agent");
    expect(await v.verify(call(a, { nonce: "n" }))).toEqual({ kind: "refused", code: "SIGNATURE_INVALID" });
  });

  it("nonce записывается только после верной подписи", async () => {
    const k = agentKey(A);
    const { v } = stand(() => [k.jwk]);
    const req = call(k, { nonce: "once" });
    expect((await v.verify({ ...req, body: new Uint8Array([1]) })).kind).toBe("refused");
    expect((await v.verify(req)).kind).toBe("agent");
  });
});

describe("MerchantAgentVerifier — кэш каталога (К25 п. 3–4)", () => {
  it("каталог читается один раз в пределах срока; по истечении — перечитывается", async () => {
    const k = agentKey(A);
    const s = stand(() => [k.jwk]);
    await s.v.verify(call(k, { at: s.at() }));
    s.tick(299_000);
    await s.v.verify(call(k, { at: s.at() }));
    expect(s.port.calls).toBe(1);
    s.tick(1_000);
    await s.v.verify(call(k, { at: s.at() }));
    expect(s.port.calls).toBe(2);
  });

  it("maxAgeSec порта задаёт срок; не целое ≥ 0 — defaultMaxAgeSec", async () => {
    const k = agentKey(A);
    const s = stand(() => [k.jwk], { maxAgeSec: 5 });
    await s.v.verify(call(k, { at: s.at() }));
    s.tick(5_000);
    await s.v.verify(call(k, { at: s.at() }));
    expect(s.port.calls).toBe(2);
    for (const bad of [-1, 1.5, Number.NaN]) {
      const t = stand(() => [k.jwk], { maxAgeSec: bad });
      await t.v.verify(call(k, { at: t.at() }));
      t.tick(299_000);
      await t.v.verify(call(k, { at: t.at() }));
      expect(t.port.calls).toBe(1);
    }
  });

  it("неизвестный kid — одно перечитывание не чаще refetchMinSec; новый ключ после перечитывания принят", async () => {
    const k = agentKey(A);
    const fresh = agentKey(A);
    let list = [k.jwk];
    const s = stand(() => list);
    await s.v.verify(call(k, { at: s.at() }));
    s.tick(30_000);
    list = [k.jwk, fresh.jwk];
    expect((await s.v.verify(call(fresh, { at: s.at() }))).kind).toBe("agent");
    expect(s.port.calls).toBe(2);
    const stranger = agentKey(A);
    for (let i = 0; i < 5; i++) expect(await s.v.verify(call(stranger, { at: s.at() }))).toEqual({ kind: "refused", code: "KEY_UNKNOWN" });
    expect(s.port.calls).toBe(2);
    s.tick(30_000);
    await s.v.verify(call(stranger, { at: s.at() }));
    expect(s.port.calls).toBe(3);
  });

  it("одновременные обращения ждут одного чтения", async () => {
    const k = agentKey(A);
    const s = stand(() => [k.jwk]);
    const rs = await Promise.all(Array.from({ length: 10 }, () => s.v.verify(call(k, { at: s.at() }))));
    expect(rs.every((r) => r.kind === "agent")).toBe(true);
    expect(s.port.calls).toBe(1);
  });

  it("сбой чтения — KEYS_UNAVAILABLE этому запросу; кэш очищен, как у платформы (поправка 1, развилка к пересмотру)", async () => {
    const k = agentKey(A);
    const stranger = agentKey(A);
    let fail = false;
    const s = stand(() => [k.jwk], { fail: () => fail });
    expect((await s.v.verify(call(k, { at: s.at() }))).kind).toBe("agent");
    s.tick(30_000);
    fail = true;
    expect(await s.v.verify(call(stranger, { at: s.at() }))).toEqual({ kind: "refused", code: "KEYS_UNAVAILABLE" });
    expect(s.v.catalog()).toMatchObject({ failed: true, keys: 0 });
    // в окне перечитывания: известный прежде kid — KEY_UNKNOWN, без нового чтения
    expect(await s.v.verify(call(k, { at: s.at() }))).toEqual({ kind: "refused", code: "KEY_UNKNOWN" });
    expect(s.port.calls).toBe(2);
    // окно прошло, каталог снова доступен — принят
    s.tick(30_000);
    fail = false;
    expect((await s.v.verify(call(k, { at: s.at() }))).kind).toBe("agent");
    expect(s.v.catalog()).toMatchObject({ failed: false, keys: 1 });
  });

  it("истёк max-age и перечитать не удалось — отказ, просроченные ключи не используются", async () => {
    const k = agentKey(A);
    let fail = false;
    const s = stand(() => [k.jwk], { fail: () => fail });
    await s.v.verify(call(k, { at: s.at() }));
    s.tick(300_000);
    fail = true;
    expect(await s.v.verify(call(k, { at: s.at() }))).toEqual({ kind: "refused", code: "KEYS_UNAVAILABLE" });
  });

  it("тело каталога не принято — как сбой; пропущенные ключи — в catalog().skipped", async () => {
    const k = agentKey(A);
    let body: unknown = { keys: "x" };
    const now = () => T0;
    const v = new MerchantAgentVerifier(async () => ({ body }), { skewSec: 30, nonces: new AsyncMemoryNonceStore({ retainMs: 60_000, now }), now, refetchMinSec: 0 });
    expect(await v.verify(call(k))).toEqual({ kind: "refused", code: "KEYS_UNAVAILABLE" });
    body = { keys: [k.jwk, { ...k.jwk, kid: "x" }, null] };
    expect((await v.verify(call(k))).kind).toBe("agent");
    expect(v.catalog()).toEqual({ fetches: 2, keys: 1, skipped: 2, fetchedAt: T0, failed: false });
  });

  it("параметры: skewSec обязателен и > 0; сроки — целые ≥ 0", () => {
    const nonces = new AsyncMemoryNonceStore({ retainMs: 1 });
    const src: AgentKeySource = async () => ({ body: { keys: [] } });
    for (const o of [{ skewSec: 0 }, { skewSec: Number.NaN }, { skewSec: 30, defaultMaxAgeSec: -1 }, { skewSec: 30, refetchMinSec: 0.5 }]) {
      expect(() => new MerchantAgentVerifier(src, { nonces, ...o })).toThrow(RangeError);
    }
  });
});
