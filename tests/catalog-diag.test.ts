import { describe, it, expect } from "vitest";
import { checkDiagRegistry } from "../src/diag/index.js";
import { PAO_DIAG } from "../src/pao/index.js";
import {
  A5_SIGNAL_CODES, CATALOG_DIAG, CATALOG_DIAG_CODES, CATALOG_ISSUE_CODES, LIVE_CHECK_CODES,
} from "../src/catalog/index.js";

describe("К17 п. 1: реестр CATALOG_DIAG", () => {
  it("полнота: 22 кода валидатора и коннектора, 2 — A5, 8 — LIVE_*, тексты ru", () => {
    expect([CATALOG_ISSUE_CODES.length, A5_SIGNAL_CODES.length, LIVE_CHECK_CODES.length]).toEqual([22, 2, 8]);
    expect(new Set(CATALOG_DIAG_CODES).size).toBe(32);
    expect(checkDiagRegistry(CATALOG_DIAG_CODES, CATALOG_DIAG)).toEqual([]);
  });

  it("component — core, since — 0.6.0, source — merchant (LIVE_UNAVAILABLE — ещё environment)", () => {
    for (const c of CATALOG_DIAG_CODES) {
      const e = CATALOG_DIAG[c];
      expect([c, e.component, e.since]).toEqual([c, "core", "0.6.0"]);
      expect([c, e.source]).toEqual([c, c === "LIVE_UNAVAILABLE" ? ["merchant", "environment"] : ["merchant"]]);
    }
  });

  it("действия: фид и A5 — after_fix; живая проверка — по смыслу кода", () => {
    for (const c of [...CATALOG_ISSUE_CODES, ...A5_SIGNAL_CODES]) expect([c, CATALOG_DIAG[c].action]).toEqual([c, "after_fix"]);
    expect(Object.fromEntries(LIVE_CHECK_CODES.map((c) => [c, CATALOG_DIAG[c].action]))).toEqual({
      LIVE_UNAVAILABLE: "retry_same_key", LIVE_INVALID: "after_fix", LIVE_STALE: "retry_same_key", LIVE_CURRENCY: "after_fix",
      LIVE_PRICE_UP: "after_human", LIVE_PRICE_DOWN: "after_human", LIVE_OUT_OF_STOCK: "stop", LIVE_QUANTITY: "after_human",
    });
  });

  it("с PAO_DIAG без общих кодов: объединённый реестр не теряет записей", () => {
    expect(Object.keys(PAO_DIAG).filter((c) => Object.hasOwn(CATALOG_DIAG, c))).toEqual([]);
    const merged = { ...PAO_DIAG, ...CATALOG_DIAG };
    expect(checkDiagRegistry([...Object.keys(PAO_DIAG), ...CATALOG_DIAG_CODES], merged)).toEqual([]);
  });
});
