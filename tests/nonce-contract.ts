// Договор AsyncNonceStore и verifyRequestAsync (К6 пп. 12–13): одни и те же случаи для памяти и PostgreSQL.
import { it, expect } from "vitest";
import { newEd25519Signer, signRequest, verifyRequest, verifyRequestAsync, type AsyncNonceStore, type NonceStoreOptions } from "../src/index.js";

export type MakeNonces = (opts: NonceStoreOptions) => AsyncNonceStore;

const SKEW = 300;
const T = Date.parse("2026-10-08T08:41:12Z");
const { signer, publicKey } = newEd25519Signer("k-1");
const key = (status: "ACTIVE" | "REVOKED") => async () => ({ alg: "ed25519", publicKey, status });
const signed = (nonce: string, body = '{"a":1}') => signRequest({ method: "POST", path: "/v1/x", query: "", body,
  headers: { "x-agent-code": "agent-1", "x-timestamp": "2026-10-08T08:41:12Z", "x-nonce": nonce } }, signer);

export function nonceContract(make: MakeNonces) {
  it("seen: первый раз — false, повтор — true; пустой nonce — true", async () => {
    const N = make({ retainMs: 600_000 });
    expect(await N.seen("n1")).toBe(false);
    expect(await N.seen("n1")).toBe(true);
    expect(await N.seen("")).toBe(true);
  });

  it("20 одновременных seen одного nonce: false ровно один раз", async () => {
    const N = make({ retainMs: 600_000 });
    const out = await Promise.all(Array.from({ length: 20 }, () => N.seen("race")));
    expect(out.filter((x) => !x).length).toBe(1);
  });

  it("purge удаляет только старше retainMs — по поддельным часам", async () => {
    let t = 1_000_000; const N = make({ retainMs: 10_000, now: () => t });
    await N.seen("old"); t += 5_000; await N.seen("young"); t += 5_001;
    expect(await N.purge()).toBe(1);
    expect(await N.seen("young")).toBe(true);
    expect(await N.seen("old")).toBe(false);
  });

  it("retainMs меньше 2 × skewSec или не положительное — RangeError", () => {
    expect(() => make({ retainMs: 2 * SKEW * 1000 - 1, skewSec: SKEW })).toThrow(RangeError);
    expect(() => make({ retainMs: 0 })).toThrow(RangeError);
    for (const skewSec of [NaN, -1, 0]) expect(() => make({ retainMs: 600_000, skewSec })).toThrow(RangeError); // /audit № 5
    expect(() => make({ retainMs: 2 * SKEW * 1000, skewSec: SKEW })).not.toThrow();
  });

  it("повтор после purge в пределах окна — отказ при retainMs = 2 × окна; при меньшем прошёл бы", async () => {
    for (const [retainMs, replayOk] of [[2 * SKEW * 1000, false], [2 * SKEW * 1000 - 1, true]] as const) {
      let now = T - SKEW * 1000; // метка на правом краю окна: принимается сейчас и ещё 2 × skewSec
      const N = make({ retainMs, now: () => now });
      const opts = () => ({ now, skewSec: SKEW, seenNonce: (n: string) => N.seen(n) });
      const s = signed(`edge-${retainMs}`);
      expect(await verifyRequestAsync(s, key("ACTIVE"), opts())).toEqual({ ok: true, kid: "k-1" });
      now = T + SKEW * 1000; // левый край окна — обращение ещё принимается по времени
      await N.purge();
      expect((await verifyRequestAsync(s, key("ACTIVE"), opts())).ok).toBe(replayOk);
    }
  });

  it("verifyRequestAsync: как verifyRequest; nonce неподписанного, подменённого и просроченного не записывается", async () => {
    const N = make({ retainMs: 2 * SKEW * 1000, skewSec: SKEW, now: () => T });
    const opts = (now = T) => ({ now, skewSec: SKEW, seenNonce: (n: string) => N.seen(n) });
    const s = signed("v1");
    expect(await verifyRequestAsync({ ...s, body: '{"a":2}' }, key("ACTIVE"), opts())).toEqual({ ok: false, code: "SIGNATURE_INVALID" });
    expect(await verifyRequestAsync(s, key("ACTIVE"), opts(T + 3_600_000))).toEqual({ ok: false, code: "SIGNATURE_INVALID" });
    const { signature: _drop, ...unsigned } = s.headers;
    expect(await verifyRequestAsync({ ...s, headers: unsigned }, key("ACTIVE"), opts())).toEqual({ ok: false, code: "SIGNATURE_INVALID" });
    expect(await verifyRequestAsync(s, async () => undefined, opts())).toEqual({ ok: false, code: "SIGNATURE_INVALID" });
    // ни один отказ выше nonce не записал — подписанное с тем же nonce проходит, повтор — нет
    expect(await verifyRequestAsync(s, key("ACTIVE"), opts())).toEqual({ ok: true, kid: "k-1" });
    expect(await verifyRequestAsync(s, key("ACTIVE"), opts())).toEqual({ ok: false, code: "SIGNATURE_INVALID" });
    // те же ответы, что у verifyRequest
    const sync = new Set<string>();
    const seen = (n: string) => { const x = sync.has(n); sync.add(n); return x; };
    const k = () => ({ alg: "ed25519", publicKey, status: "ACTIVE" as const });
    expect(verifyRequest(s, k, { now: T, skewSec: SKEW, seenNonce: seen })).toEqual({ ok: true, kid: "k-1" });
    expect(verifyRequest(s, k, { now: T, skewSec: SKEW, seenNonce: seen })).toEqual({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("verifyRequestAsync: отозванный ключ — AGENT_KEY_REVOKED и при повторе nonce (в verifyRequest — SIGNATURE_INVALID)", async () => {
    const N = make({ retainMs: 2 * SKEW * 1000, now: () => T });
    const s = signed("rv");
    expect(await N.seen("rv")).toBe(false);
    expect(await verifyRequestAsync(s, key("REVOKED"), { now: T, skewSec: SKEW, seenNonce: (n) => N.seen(n) })).toEqual({ ok: false, code: "AGENT_KEY_REVOKED" });
    expect(verifyRequest(s, () => ({ alg: "ed25519", publicKey, status: "REVOKED" }), { now: T, skewSec: SKEW, seenNonce: () => true }))
      .toEqual({ ok: false, code: "SIGNATURE_INVALID" });
  });
}
