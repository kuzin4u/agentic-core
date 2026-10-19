import { describe, it, expect } from "vitest";
import * as core from "../src/index.js";
import { checkSituations, outcomeMatches, paramsAt, gridSizeOf, ruleFor, isExcluded, type TrialSituation } from "../src/trials/index.js";

const sit = (over: Partial<Record<keyof TrialSituation, unknown>> = {}): TrialSituation => ({
  id: "s1", refs: ["РЗ-74"], params: { a: [1, 2], b: ["x", "y", "z"] },
  expect: [{ when: { a: [1] }, outcome: { result: "ok" } }, { outcome: { result: "refuse", code: "C" } }],
  rejected: [{ variant: "alt", note: "отклонённый вариант" }],
  ...over,
} as TrialSituation);

describe("К19 п. 1: формат ситуации и проверка каталога", () => {
  it("годный каталог — без замечаний", () => {
    expect(checkSituations([sit(), sit({ id: "s2", refs: ["КП-8", "РЗ-1"] })])).toEqual([]);
  });

  it("исход — по подмножеству ключей, сравнение через canonicalJson", () => {
    expect(outcomeMatches({ result: "ok" }, { result: "ok", at: "2026-10-19T00:00:00Z" })).toBe(true);
    expect(outcomeMatches({ x: { b: 1, a: 2 } }, { x: { a: 2, b: 1 } })).toBe(true);
    expect(outcomeMatches({ result: "ok" }, { result: "refuse" })).toBe(false);
    expect(outcomeMatches({ code: null }, {})).toBe(false);
    expect(outcomeMatches({ n: 1 }, { n: "1" })).toBe(false);
    expect(outcomeMatches({}, null)).toBe(false);
    expect(outcomeMatches({ d: "x" }, { d: new Date(0) })).toBe(false);
  });

  it("повтор и формат id, ссылки", () => {
    expect(checkSituations([sit(), sit(), sit({ id: "a#1" }), sit({ id: " " })])).toEqual([
      { code: "TRIALS_ID_DUPLICATE", situation: "s1", field: "id" },
      { code: "TRIALS_ID_DUPLICATE", situation: "#2", field: "id" },
      { code: "TRIALS_ID_DUPLICATE", situation: "#3", field: "id" },
    ]);
    for (const refs of [[], ["Р-74"], ["РЗ-0"], ["К-8"], ["РЗ-074"], "РЗ-1"]) {
      expect(checkSituations([sit({ refs })])).toEqual([{ code: "TRIALS_REF_INVALID", situation: "s1", field: "refs" }]);
    }
  });

  it("параметры: пустой список, не JSON", () => {
    expect(checkSituations([sit({ params: { a: [], b: [1] }, expect: [{ outcome: {} }] })])).toEqual([
      { code: "TRIALS_PARAMS_EMPTY", situation: "s1", field: "params.a" },
    ]);
    expect(checkSituations([sit({ params: { a: [new Date(0)] }, expect: [{ outcome: {} }] })])).toEqual([
      { code: "TRIALS_PARAMS_EMPTY", situation: "s1", field: "params.a" },
    ]);
    expect(checkSituations([sit({ params: [1] })])).toContainEqual({ code: "TRIALS_PARAMS_EMPTY", situation: "s1", field: "params" });
  });

  it("ключи when и exclude — из params, значения — из домена", () => {
    expect(checkSituations([sit({ expect: [{ when: { c: [1] }, outcome: {} }, { outcome: {} }] })])).toEqual([
      { code: "TRIALS_RULE_KEY", situation: "s1", field: "expect.0.when" },
    ]);
    expect(checkSituations([sit({ expect: [{ when: { a: [3] }, outcome: {} }, { outcome: {} }] })])).toEqual([
      { code: "TRIALS_RULE_KEY", situation: "s1", field: "expect.0.when" },
    ]);
    expect(checkSituations([sit({ expect: [{ when: { a: [] }, outcome: {} }, { outcome: {} }] })])).toEqual([
      { code: "TRIALS_RULE_KEY", situation: "s1", field: "expect.0.when" },
    ]);
    expect(checkSituations([sit({ exclude: [{ a: 9 }] })])).toEqual([{ code: "TRIALS_RULE_KEY", situation: "s1", field: "exclude" }]);
    expect(checkSituations([sit({ exclude: [{ a: 1, b: "x" }] })])).toEqual([]);
  });

  it("нет правил, исход не объект, сочетание без правила", () => {
    expect(checkSituations([sit({ expect: [] })])).toEqual([{ code: "TRIALS_NO_EXPECT", situation: "s1", field: "expect" }]);
    expect(checkSituations([sit({ expect: [{ outcome: [1] }] })])).toEqual([{ code: "TRIALS_NO_EXPECT", situation: "s1", field: "expect.0" }]);
    // a = 2 без правила; номер сочетания — в поле
    expect(checkSituations([sit({ expect: [{ when: { a: [1] }, outcome: {} }] })])).toEqual([
      { code: "TRIALS_NO_EXPECT", situation: "s1", field: "s1#3" },
    ]);
    // исключённое сочетание правила не требует
    expect(checkSituations([sit({ expect: [{ when: { a: [1] }, outcome: {} }], exclude: [{ a: 2 }] })])).toEqual([]);
  });

  it("отклонённые варианты: пусто без rejectedNone, основание, имена", () => {
    expect(checkSituations([sit({ rejected: [] })])).toEqual([{ code: "TRIALS_REJECTED_MISSING", situation: "s1", field: "rejectedNone" }]);
    expect(checkSituations([sit({ rejected: [], rejectedNone: { basis: "process", reason: "нет второго варианта в коде" } })])).toEqual([]);
    expect(checkSituations([sit({ rejected: [], rejectedNone: { basis: "later", reason: " " } })])).toEqual([
      { code: "TRIALS_EXCLUSION_BASIS", situation: "s1", field: "rejectedNone.basis" },
      { code: "TRIALS_EXCLUSION_REASON", situation: "s1", field: "rejectedNone.reason" },
    ]);
    expect(checkSituations([sit({ rejected: [
      { variant: "chosen", note: "n" }, { variant: "v", note: "n" }, { variant: "v", note: "n" }, { variant: "w", note: "" }, { variant: "u", note: "n", must: "some" },
    ] })])).toEqual([0, 2, 3, 4].map((j) => ({ code: "TRIALS_REJECTED_MISSING", situation: "s1", field: `rejected.${j}` })));
    expect(checkSituations([sit({ rejected: undefined })])).toEqual([{ code: "TRIALS_REJECTED_MISSING", situation: "s1", field: "rejected" }]);
  });

  it("не объект вместо ситуации", () => {
    expect(checkSituations([null as unknown as TrialSituation])).toEqual([{ code: "TRIALS_ID_DUPLICATE", situation: "#0" }]);
  });

  it("нумерация сетки: ключи по порядку canonicalJson, первый — старший разряд", () => {
    const s = sit({ params: { b: ["x", "y", "z"], a: [1, 2] } });
    expect(gridSizeOf(s)).toBe(6);
    expect([0, 1, 2, 3, 4, 5].map((n) => paramsAt(s, n))).toEqual([
      { a: 1, b: "x" }, { a: 1, b: "y" }, { a: 1, b: "z" }, { a: 2, b: "x" }, { a: 2, b: "y" }, { a: 2, b: "z" },
    ]);
    expect(Object.keys(paramsAt(s, 0))).toEqual(["a", "b"]);
    expect(gridSizeOf(sit({ params: {} }))).toBe(1);
    expect(paramsAt(sit({ params: {} }), 0)).toEqual({});
    const big = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`p${i}`, [0, 1]]));
    expect(gridSizeOf(sit({ params: big }))).toBe(Infinity);
  });

  it("первое подходящее правило и исключение по частичному набору", () => {
    const s = sit();
    expect(ruleFor(s, { a: 1, b: "x" })?.outcome).toEqual({ result: "ok" });
    expect(ruleFor(s, { a: 2, b: "x" })?.outcome).toEqual({ result: "refuse", code: "C" });
    expect(isExcluded(sit({ exclude: [{ a: 2, b: "y" }] }), { a: 2, b: "y" })).toBe(true);
    expect(isExcluded(sit({ exclude: [{ a: 2, b: "y" }] }), { a: 2, b: "x" })).toBe(false);
  });

  it("основной вход /trials не реэкспортирует", () => {
    for (const name of ["checkSituations", "runTrials", "checkCoverage", "TRIAL_ITEMS"]) expect(name in core).toBe(false);
  });
});
