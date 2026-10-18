import { describe, it, expect } from "vitest";
import * as core from "../src/index.js";
import { checkDiagRegistry, diagAction, type DiagEntry, type DiagRegistry } from "../src/diag/index.js";
import { PAO_DIAG, PAO_ERRORS, PAO_RETRY_ACTION, PAO_SCHEMAS } from "../src/pao/index.js";

const PAO_CODES = (PAO_SCHEMAS.ErrorCode as { enum: string[] }).enum;

const entry = (code: string, over: Partial<Record<keyof DiagEntry, unknown>> = {}): DiagEntry => ({
  code, component: "core", source: ["merchant"], action: "stop",
  human: { ru: "Текст человеку." }, operator: { ru: "Текст оператору." }, norm: "К17", since: "0.8.0",
  ...over,
} as DiagEntry);

describe("К17: формат реестра кодов /diag", () => {
  it("полный реестр — без замечаний", () => {
    expect(checkDiagRegistry(["A_ONE", "B_TWO"], { A_ONE: entry("A_ONE"), B_TWO: entry("B_TWO") })).toEqual([]);
  });

  it("код без записи и лишняя запись", () => {
    expect(checkDiagRegistry(["A_ONE", "B_TWO"], { A_ONE: entry("A_ONE"), C_X: entry("C_X") })).toEqual([
      { code: "DIAG_MISSING", entry: "B_TWO" },
      { code: "DIAG_EXTRA", entry: "C_X" },
    ]);
  });

  it("ключ, формат кода, перечни, пустые поля, языки", () => {
    const reg: DiagRegistry = {
      a_low: entry("a_low"),
      K: entry("OTHER"),
      E1: entry("E1", { component: "bank", source: [], action: "retry" }),
      E2: entry("E2", { source: ["merchant", "merchant"], norm: " ", since: "" }),
      E3: entry("E3", { source: ["seller"], human: { ru: "Есть.", en: "" }, operator: { en: "Only en" } }),
      E4: entry("E4", { human: null }),
    };
    expect(checkDiagRegistry(Object.keys(reg), reg)).toEqual([
      { code: "DIAG_CODE_FORMAT", entry: "a_low" },
      { code: "DIAG_KEY_MISMATCH", entry: "K", field: "code" },
      { code: "DIAG_ENUM", entry: "E1", field: "component" },
      { code: "DIAG_ENUM", entry: "E1", field: "source" },
      { code: "DIAG_ENUM", entry: "E1", field: "action" },
      { code: "DIAG_ENUM", entry: "E2", field: "source" },
      { code: "DIAG_EMPTY", entry: "E2", field: "norm" },
      { code: "DIAG_EMPTY", entry: "E2", field: "since" },
      { code: "DIAG_ENUM", entry: "E3", field: "source" },
      { code: "DIAG_EMPTY", entry: "E3", field: "human" },
      { code: "DIAG_EMPTY", entry: "E3", field: "operator" },
      { code: "DIAG_EMPTY", entry: "E4", field: "human" },
    ]);
  });

  it("langs: каждый язык обязателен в обоих текстах", () => {
    const reg = { A: entry("A", { human: { ru: "Да.", en: "Yes." } }) };
    expect(checkDiagRegistry(["A"], reg, { langs: ["ru", "en"] })).toEqual([{ code: "DIAG_EMPTY", entry: "A", field: "operator" }]);
  });

  it("запись не объект; ключ из прототипа не считается записью", () => {
    const reg = { A: null } as unknown as DiagRegistry;
    expect(checkDiagRegistry(["A", "TO_STRING"], reg)).toEqual([
      { code: "DIAG_MISSING", entry: "TO_STRING" },
      { code: "DIAG_EMPTY", entry: "A" },
    ]);
    expect(checkDiagRegistry(["constructor"], {})).toEqual([
      { code: "DIAG_CODE_FORMAT", entry: "constructor" },
      { code: "DIAG_MISSING", entry: "constructor" },
    ]);
  });

  it("diagAction: неизвестный код и действие вне перечня — stop (К17 п. 4)", () => {
    const reg = { A: entry("A", { action: "new_key" }), B: entry("B", { action: "later" }) };
    expect(diagAction(reg, "A")).toBe("new_key");
    expect(diagAction(reg, "B")).toBe("stop");
    expect(diagAction(reg, "NEW_FROM_NEIGHBOUR")).toBe("stop");
    expect(diagAction(reg, "toString")).toBe("stop");
  });

  it("основной вход не реэкспортирует /diag", () => {
    expect(Object.keys(core)).not.toContain("checkDiagRegistry");
    expect(Object.keys(core)).not.toContain("PAO_DIAG");
  });
});

describe("К17 п. 5: реестр PAO_DIAG", () => {
  it("полнота: 20 кодов ErrorCode ПАО 1.4.0, тексты ru", () => {
    expect(PAO_CODES).toHaveLength(20);
    expect(checkDiagRegistry(PAO_CODES, PAO_DIAG)).toEqual([]);
  });

  it("action совпадает с retry из x-pao-errors, component — pao", () => {
    for (const c of PAO_CODES as (keyof typeof PAO_ERRORS)[]) {
      expect([c, PAO_DIAG[c].action]).toEqual([c, PAO_RETRY_ACTION[PAO_ERRORS[c].retry]]);
      expect(PAO_DIAG[c].component).toBe("pao");
    }
  });

  it("since: 1.3.0 — только REQUEST_INVALID и KEY_INVALID (К11)", () => {
    const late = Object.values(PAO_DIAG).filter((e) => e.since !== "1.1.0").map((e) => [e.code, e.since]);
    expect(late).toEqual([["REQUEST_INVALID", "1.3.0"], ["KEY_INVALID", "1.3.0"]]);
  });

  it("тексты — постоянные строки без подстановок и идентификаторов", () => {
    for (const e of Object.values(PAO_DIAG)) {
      for (const t of [e.human.ru, e.operator.ru]) {
        expect(t).not.toMatch(/[{}<>$]|\d{4,}/);
      }
    }
  });
});
