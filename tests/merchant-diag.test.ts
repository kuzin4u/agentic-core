// К25 п. 8: реестр MERCHANT_DIAG в формате /diag (К17).
import { describe, expect, it } from "vitest";
import { checkDiagRegistry } from "../src/diag/index.js";
import { PAO_CLIENT_DIAG, PAO_DIAG } from "../src/pao/index.js";
import { CATALOG_DIAG } from "../src/catalog/index.js";
import { MERCHANT_DIAG, MERCHANT_DIAG_CODES } from "../src/merchant/index.js";

describe("К25 п. 8: реестр MERCHANT_DIAG", () => {
  it("полнота: 7 кодов, тексты ru, проверка реестра — []", () => {
    expect(new Set(MERCHANT_DIAG_CODES).size).toBe(7);
    expect(Object.keys(MERCHANT_DIAG).sort()).toEqual([...MERCHANT_DIAG_CODES].sort());
    expect(checkDiagRegistry(MERCHANT_DIAG_CODES, MERCHANT_DIAG)).toEqual([]);
  });

  it("component — core, since — 0.13.0; KEYS_UNAVAILABLE — платформа и среда, повтор; остальные — агент, стоп", () => {
    for (const c of MERCHANT_DIAG_CODES) {
      const e = MERCHANT_DIAG[c];
      expect([c, e.code, e.component, e.since]).toEqual([c, c, "core", "0.13.0"]);
      expect([c, e.source, e.action]).toEqual(c === "KEYS_UNAVAILABLE" ? [c, ["platform", "environment"], "retry_same_key"] : [c, ["agent"], "stop"]);
    }
  });

  it("коды без приставки MERCHANT_; с PAO_DIAG общий только SIGNATURE_INVALID — отказ подписи агента", () => {
    expect(MERCHANT_DIAG_CODES.filter((c) => c.startsWith("MERCHANT_"))).toEqual([]);
    expect(MERCHANT_DIAG_CODES.filter((c) => Object.hasOwn(PAO_DIAG, c))).toEqual(["SIGNATURE_INVALID"]);
    expect(PAO_DIAG.SIGNATURE_INVALID!.operator.ru).toMatch(/подпис/i);
    expect(MERCHANT_DIAG.SIGNATURE_INVALID.operator.ru).toMatch(/подпис/i);
    expect(MERCHANT_DIAG_CODES.filter((c) => Object.hasOwn(CATALOG_DIAG, c) || Object.hasOwn(PAO_CLIENT_DIAG, c))).toEqual([]);
  });

  it("тексты человеку без технических имён и без бренда", () => {
    for (const c of MERCHANT_DIAG_CODES) expect([c, /[a-z_]{3,}|keyid|JWKS|kid/i.test(MERCHANT_DIAG[c].human.ru.replace(/[а-яё]/gi, ""))]).toEqual([c, false]);
  });
});
