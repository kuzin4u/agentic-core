import { describe, it, expect } from "vitest";
import { checkDiagRegistry, diagAction } from "../src/diag/index.js";
import { PAO_CLIENT_CODES, PAO_CLIENT_DIAG, PAO_DIAG } from "../src/pao/index.js";

describe("К18 п. 2: реестр PAO_CLIENT_DIAG", () => {
  it("полнота: два кода клиента, тексты ru", () => {
    expect([...PAO_CLIENT_CODES]).toEqual(["PAO_CLIENT_REDIRECT", "PAO_CLIENT_SIGNER_MISSING"]);
    expect(checkDiagRegistry(PAO_CLIENT_CODES, PAO_CLIENT_DIAG)).toEqual([]);
  });

  it("component — core, since — 0.9.0, действие — after_fix", () => {
    for (const c of PAO_CLIENT_CODES) {
      const e = PAO_CLIENT_DIAG[c];
      expect([c, e.component, e.since, e.action, diagAction(PAO_CLIENT_DIAG, c)]).toEqual([c, "core", "0.9.0", "after_fix", "after_fix"]);
    }
    expect(PAO_CLIENT_DIAG.PAO_CLIENT_REDIRECT.source).toEqual(["agent", "platform", "environment"]);
    expect(PAO_CLIENT_DIAG.PAO_CLIENT_SIGNER_MISSING.source).toEqual(["agent"]);
    expect(PAO_CLIENT_DIAG.PAO_CLIENT_REDIRECT.operator.ru).toContain("оформите инцидент");
  });

  it("PAO_DIAG не меняется: 20 кодов, общих с клиентом нет; объединённый реестр полон", () => {
    expect(Object.keys(PAO_DIAG)).toHaveLength(20);
    expect(PAO_CLIENT_CODES.filter((c) => Object.hasOwn(PAO_DIAG, c))).toEqual([]);
    const merged = { ...PAO_DIAG, ...PAO_CLIENT_DIAG };
    expect(checkDiagRegistry([...Object.keys(PAO_DIAG), ...PAO_CLIENT_CODES], merged)).toEqual([]);
  });
});
