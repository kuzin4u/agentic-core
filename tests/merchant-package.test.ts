// К25 п. 6–7: пакет агентской оплаты — подпись по байтам, строгий разбор после подписи, aoi.agent_code ↔ агент подписи.
import { describe, expect, it } from "vitest";
import { sign } from "node:crypto";
import { AsyncMemoryNonceStore, signRequest, type HttpLike } from "../src/index.js";
import { MerchantAgentVerifier, acquirerMetadata, decodePaymentPackage, parsePaymentPackage } from "../src/merchant/index.js";
import { agentKey } from "./merchant-keys.js";

const T0 = 1_800_000_000_000;
const A = "nspk:agent:a:v1";
const B = "nspk:agent:b:v1";

const card = (agent = A) => ({
  credential_ref: "CRD-1",
  kind: "CARD",
  payload: { token_ref: "TKN-1", cryptogram: "AAEC", valid_to: "2027-01-01T00:00:00Z" },
  aoi: { indicator: true, agent_code: agent, mandate_id: "MND-1" },
  cart_mandate_id: "MND-CART-1",
  order_ref: "ORD-1",
});

let seq = 0;
function post(k: ReturnType<typeof agentKey>, body: string | Uint8Array): HttpLike {
  return signRequest(
    { method: "POST", path: "/orders/ORD-1/payment", query: "", headers: { "x-agent-code": k.jwk.agent_code, "x-timestamp": new Date(T0).toISOString(), "x-nonce": `p-${++seq}` }, body },
    { kid: k.jwk.kid, alg: "ed25519", sign: (d) => sign(null, d, k.privateKey) },
  );
}

function verifier(keys: unknown[]) {
  const now = () => T0;
  return new MerchantAgentVerifier(async () => ({ body: { keys } }), { skewSec: 30, nonces: new AsyncMemoryNonceStore({ retainMs: 60_000, now }), now });
}

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe("parsePaymentPackage — как у платформы", () => {
  it("CARD и SBP по форме; лишние поля, в том числе сумма, не переносятся", () => {
    const p = parsePaymentPackage({ ...card(), amount: 100500, payload: { ...card().payload, pan: "4111" }, aoi: { ...card().aoi, x: 1 } })!;
    expect(p).toEqual(card());
    expect(JSON.stringify(p)).not.toMatch(/amount|pan|"x"/);
    const sbp = { ...card(), kind: "SBP", payload: { account_link_ref: "ALR-1" }, aoi: { ...card().aoi, fulfilment_ref: null, deal_ref: "D-1" } };
    expect(parsePaymentPackage(sbp)).toEqual(sbp);
  });

  it("не по форме — null", () => {
    const c = card();
    const bad: unknown[] = [
      null, [], "x",
      { ...c, credential_ref: "" }, { ...c, cart_mandate_id: 1 }, { ...c, order_ref: undefined },
      { ...c, kind: "CASH" }, { ...c, payload: [] }, { ...c, aoi: null },
      { ...c, payload: { token_ref: "T" } },                                  // CARD без криптограммы
      { ...c, payload: { ...c.payload, account_link_ref: "A" } },            // CARD с привязкой
      { ...c, kind: "SBP" },                                                  // SBP с токеном
      { ...c, kind: "SBP", payload: {} },
      { ...c, payload: { ...c.payload, valid_to: 1 } },
      { ...c, aoi: { ...c.aoi, indicator: "true" } }, { ...c, aoi: { ...c.aoi, agent_code: "" } }, { ...c, aoi: { ...c.aoi, mandate_id: 1 } },
      { ...c, aoi: { ...c.aoi, fulfilment_ref: "" } }, { ...c, aoi: { ...c.aoi, deal_ref: 5 } },
    ];
    for (const b of bad) expect(parsePaymentPackage(b)).toBeNull();
    expect(parsePaymentPackage(Object.create(card()))).toBeNull();
  });

  it("valid_to — строка без проверки даты, как у платформы (к пересмотру по К20)", () => {
    expect(parsePaymentPackage({ ...card(), payload: { ...card().payload, valid_to: "не дата" } })?.payload.valid_to).toBe("не дата");
  });

  it("decodePaymentPackage: строгий UTF-8, BOM не снимается, не JSON — null", () => {
    expect(decodePaymentPackage(bytes(card()))).toEqual(card());
    expect(decodePaymentPackage(JSON.stringify(card()))).toEqual(card());
    const bad = bytes(card());
    bad[bad.indexOf(0x4f)] = 0xff; // байт не UTF-8 внутри строки
    expect(decodePaymentPackage(bad)).toBeNull();
    expect(decodePaymentPackage(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(card())]))).toBeNull();
    expect(decodePaymentPackage(new Uint8Array([123]))).toBeNull();
    expect(decodePaymentPackage(undefined)).toBeNull();
  });

  it("acquirerMetadata — credential_ref, order_ref, aoi; без суммы и payload", () => {
    expect(acquirerMetadata(parsePaymentPackage(card())!)).toEqual({ credential_ref: "CRD-1", order_ref: "ORD-1", aoi: card().aoi });
  });
});

describe("verifyPackage", () => {
  it("верный пакет — package", async () => {
    const k = agentKey(A);
    const r = await verifier([k.jwk]).verifyPackage(post(k, bytes(card())));
    expect(r).toEqual({ kind: "package", agentCode: A, kid: k.jwk.kid, package: card() });
  });

  it("aoi.agent_code ≠ агенту подписи — PACKAGE_AGENT_MISMATCH", async () => {
    const k = agentKey(A);
    expect(await verifier([k.jwk]).verifyPackage(post(k, bytes(card(B))))).toEqual({ kind: "refused", code: "PACKAGE_AGENT_MISMATCH" });
  });

  it("aoi.mandate_id и cart_mandate_id не сверяются (нормы нет)", async () => {
    const k = agentKey(A);
    expect((await verifier([k.jwk]).verifyPackage(post(k, bytes({ ...card(), cart_mandate_id: "другой" })))).kind).toBe("package");
  });

  it("тело не UTF-8 — подпись по байтам верна, затем PACKAGE_INVALID", async () => {
    const k = agentKey(A);
    const body = bytes(card());
    body[body.indexOf(0x4f)] = 0xff;
    const v = verifier([k.jwk]);
    const req = post(k, body);
    expect((await v.verify({ ...req, headers: { ...req.headers, "x-nonce": req.headers["x-nonce"]! } })).kind).toBe("agent");
    expect(await v.verifyPackage(post(k, body))).toEqual({ kind: "refused", code: "PACKAGE_INVALID" });
  });

  it("не JSON и не по форме — PACKAGE_INVALID", async () => {
    const k = agentKey(A);
    const v = verifier([k.jwk]);
    expect(await v.verifyPackage(post(k, "{"))).toEqual({ kind: "refused", code: "PACKAGE_INVALID" });
    expect(await v.verifyPackage(post(k, bytes({ ...card(), kind: "CASH" })))).toEqual({ kind: "refused", code: "PACKAGE_INVALID" });
  });

  it("подпись проверяется до разбора: битая подпись и битое тело — SIGNATURE_INVALID", async () => {
    const k = agentKey(A);
    const req = post(k, new Uint8Array([0xff]));
    expect(await verifier([k.jwk]).verifyPackage({ ...req, body: new Uint8Array([0xfe]) })).toEqual({ kind: "refused", code: "SIGNATURE_INVALID" });
  });

  it("неподписанный пакет — SIGNATURE_INVALID; отказ обращения — его код", async () => {
    const k = agentKey(A);
    const v = verifier([k.jwk]);
    expect(await v.verifyPackage({ method: "POST", path: "/", headers: {}, body: bytes(card()) })).toEqual({ kind: "refused", code: "SIGNATURE_INVALID" });
    expect(await v.verifyPackage(post(agentKey(A), bytes(card())))).toEqual({ kind: "refused", code: "KEY_UNKNOWN" });
  });
});
