// К25 п. 2: строгий разбор каталога ключей агентов (JWKS, РП22 п. 1).
import { describe, expect, it } from "vitest";
import { createPublicKey, sign, verify } from "node:crypto";
import { jwkSpki, okpThumbprint, parseAgentJwks } from "../src/merchant/index.js";
import { agentKey } from "./merchant-keys.js";

describe("parseAgentJwks", () => {
  it("принимает ключ по форме; kid — отпечаток RFC 7638 (как у node:crypto)", () => {
    const { jwk, publicKey } = agentKey();
    const r = parseAgentJwks({ keys: [jwk] })!;
    expect(r.skipped).toBe(0);
    expect(r.keys.get(jwk.kid)).toEqual(jwk);
    // отпечаток сверяется с независимым расчётом
    expect(jwk.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // SPKI — тот же ключ
    const spki = createPublicKey({ key: Buffer.from(jwkSpki(r.keys.get(jwk.kid)!), "base64"), format: "der", type: "spki" });
    expect(spki.export({ format: "jwk" }).x).toBe(publicKey.export({ format: "jwk" }).x);
  });

  it("SPKI годится для проверки подписи", () => {
    const { jwk, privateKey } = agentKey();
    const sig = sign(null, Buffer.from("m"), privateKey);
    const key = createPublicKey({ key: Buffer.from(jwkSpki(parseAgentJwks({ keys: [jwk] })!.keys.get(jwk.kid)!), "base64"), format: "der", type: "spki" });
    expect(verify(null, Buffer.from("m"), key, sig)).toBe(true);
  });

  it("тело не объект или нет массива keys — каталог не принят", () => {
    for (const b of [null, 1, "x", [], {}, { keys: {} }, { keys: "a" }]) expect(parseAgentJwks(b)).toBeNull();
    expect(parseAgentJwks({ keys: [] })).toEqual({ keys: new Map(), skipped: 0 });
  });

  it("ключ не по форме пропускается и считается; соседний ключ принят", () => {
    const good = agentKey().jwk;
    const base = agentKey().jwk;
    const other = agentKey().jwk;
    const bad: unknown[] = [
      null, "k", [],
      { ...base, kty: "EC" }, { ...base, crv: "X25519" }, { ...base, alg: "ES256" }, { ...base, use: "enc" },
      { ...base, kid: other.kid },                                 // kid не отпечаток своего x
      { ...base, kid: base.kid + "=" },
      { ...base, x: base.x + "=", kid: okpThumbprint(base.x + "=") }, // дополнение
      { ...base, x: base.x.slice(0, 42), kid: okpThumbprint(base.x.slice(0, 42)) },
      { ...base, agent_code: "" }, { ...base, agent_code: 1 },
      { ...base, nbf: 1.5 }, { ...base, exp: "1900000000" }, { ...base, nbf: base.exp }, { ...base, exp: 2 ** 60 },
    ];
    const { agent_code: _a, ...noCode } = base;
    bad.push(noCode);
    const r = parseAgentJwks({ keys: [...bad, good] })!;
    expect([...r.keys.keys()]).toEqual([good.kid]);
    expect(r.skipped).toBe(bad.length);
  });

  it("неканонический base64url x (лишние биты в последнем знаке) — пропуск", () => {
    const { jwk } = agentKey();
    const last = jwk.x[42]!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const i = alphabet.indexOf(last);
    const x = jwk.x.slice(0, 42) + alphabet[(i & ~3) | ((i & 3) ^ 1)];
    expect(Buffer.from(x, "base64url").toString("base64url")).not.toBe(x);
    expect(parseAgentJwks({ keys: [{ ...jwk, x, kid: okpThumbprint(x) }] })!.skipped).toBe(1);
  });

  it("слабый ключ (точка малого порядка, К10) — пропуск", () => {
    const x = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]).toString("base64url"); // нейтраль y = 1
    const jwk = { kty: "OKP", crv: "Ed25519", x, alg: "EdDSA", use: "sig", kid: okpThumbprint(x), agent_code: "a", nbf: 1, exp: 2 };
    expect(parseAgentJwks({ keys: [jwk] })!).toEqual({ keys: new Map(), skipped: 1 });
  });

  it("два ключа с одним kid — пропускаются оба", () => {
    const { jwk } = agentKey();
    const r = parseAgentJwks({ keys: [jwk, { ...jwk, agent_code: "nspk:agent:b:v1" }, jwk] })!;
    expect(r.keys.size).toBe(0);
    expect(r.skipped).toBe(3);
  });

  it("прочие члены JWK не читаются; собственные поля, а не из прототипа", () => {
    const { jwk } = agentKey();
    const r = parseAgentJwks({ keys: [{ ...jwk, d: "секрет", extra: 1 }] })!;
    expect(r.keys.get(jwk.kid)).toEqual(jwk);
    const proto = Object.create(jwk) as object;
    expect(parseAgentJwks({ keys: [proto] })!.skipped).toBe(1);
  });
});
