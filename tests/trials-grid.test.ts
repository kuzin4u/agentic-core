import { describe, it, expect } from "vitest";
import { mulberry32, expandCases, caseByKey, TrialError, type TrialSituation } from "../src/trials/index.js";

const sit = (over: Partial<TrialSituation> = {}): TrialSituation => ({
  id: "s", refs: ["РЗ-74"], params: { a: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], b: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
  expect: [{ when: { a: [0] }, outcome: { r: "zero" } }, { outcome: { r: "other" } }],
  rejected: [{ variant: "alt", note: "n" }],
  ...over,
});

// Эталон mulberry32 (запись автора алгоритма, bryc): независимая копия для сверки.
function reference(a: number): () => number {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

describe("К19 п. 3: сетка, выборка с зерном, ключ случая", () => {
  it("mulberry32 — закреплённые значения и сверка с эталоном на 10 000 шагах", () => {
    const g = mulberry32(0);
    expect([g(), g(), g()]).toEqual([1144304738, 1416247, 958946056]);
    const h = mulberry32(19102026);
    expect([h(), h()]).toEqual([1855600907, 3773922946]);
    for (const seed of [1, 0xffffffff, 2 ** 31]) {
      const x = mulberry32(seed), y = reference(seed);
      for (let i = 0; i < 10_000; i++) expect(x()).toBe(y());
    }
  });

  it("сетка: все сочетания по номеру, исключённые выпадают, ожидаемый исход — по правилу", () => {
    const cases = expandCases(sit({ exclude: [{ a: 9 }] }), { mode: "grid" });
    expect(cases.length).toBe(90);
    expect(cases[0]).toEqual({ situation: "s", key: "s#0", index: 0, params: { a: 0, b: 0 }, expected: { r: "zero" } });
    expect(cases[89]?.key).toBe("s#89");
    expect(cases[89]?.expected).toEqual({ r: "other" });
  });

  it("сетка больше maxCases — TRIALS_GRID_TOO_LARGE", () => {
    expect(() => expandCases(sit(), { mode: "grid" }, { maxCases: 99 })).toThrow(TrialError);
    try { expandCases(sit(), { mode: "grid" }, { maxCases: 99 }); } catch (e) { expect((e as TrialError).code).toBe("TRIALS_GRID_TOO_LARGE"); }
    expect(expandCases(sit(), { mode: "grid" }, { maxCases: 100 }).length).toBe(100);
  });

  it("выборка: то же зерно — те же случаи, разные номера без повтора, по возрастанию", () => {
    const a = expandCases(sit(), { mode: "sample", n: 10, seed: 7 });
    const b = expandCases(sit(), { mode: "sample", n: 10, seed: 7 });
    const c = expandCases(sit(), { mode: "sample", n: 10, seed: 8 });
    expect(a).toEqual(b);
    expect(a.map((x) => x.key)).not.toEqual(c.map((x) => x.key));
    expect(new Set(a.map((x) => x.index)).size).toBe(10);
    expect(a.map((x) => x.index)).toEqual([...a.map((x) => x.index)].sort((x, y) => x - y));
  });

  it("выборка — закреплённые номера (смена генератора или нумерации ломает случаи при том же зерне)", () => {
    expect(expandCases(sit(), { mode: "sample", n: 5, seed: 19102026 }).map((x) => x.key)).toEqual(["s#7", "s#24", "s#43", "s#72", "s#80"]);
  });

  it("выборка не меньше сетки — полный перебор; исключённые не выбираются", () => {
    expect(expandCases(sit(), { mode: "sample", n: 100, seed: 1 }).length).toBe(100);
    const s = sit({ exclude: [{ a: 0 }, { a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }] });
    const got = expandCases(s, { mode: "sample", n: 40, seed: 3 });
    expect(got.length).toBe(40);
    expect(got.every((x) => (x.params.a as number) >= 5)).toBe(true);
    // почти всё исключено: попытки ограничены, случаев меньше n
    const tight = sit({ exclude: Array.from({ length: 10 }, (_, i) => ({ a: i })).slice(1) });
    expect(expandCases(tight, { mode: "sample", n: 50, seed: 5 }).length).toBe(10);
  });

  it("выборка из огромной сетки — номера за пределами 2^32", () => {
    const params = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${String(i).padStart(2, "0")}`, [0, 1]]));
    const got = expandCases(sit({ params, expect: [{ outcome: {} }] }), { mode: "sample", n: 20, seed: 11 });
    expect(got.length).toBe(20);
    expect(got.some((x) => x.index > 2 ** 32)).toBe(true);
    expect(() => expandCases(sit({ params, expect: [{ outcome: {} }] }), { mode: "grid" })).toThrow(TrialError);
  });

  it("зерно и n проверяются", () => {
    for (const seed of [-1, 1.5, 2 ** 32, Number.NaN]) expect(() => expandCases(sit(), { mode: "sample", n: 1, seed })).toThrow(RangeError);
    for (const n of [0, -1, 1.5]) expect(() => expandCases(sit(), { mode: "sample", n, seed: 1 })).toThrow(RangeError);
  });

  it("случай по ключу — без зерна; чужой, вне сетки, исключённый, кривой — RangeError", () => {
    const s = sit({ exclude: [{ a: 9, b: 9 }] });
    const k = expandCases(s, { mode: "sample", n: 3, seed: 42 })[1];
    expect(caseByKey(s, k?.key as string)).toEqual(k);
    for (const key of ["t#1", "s#100", "s#99", "s#", "s#01", "s#1.0", "s"]) expect(() => caseByKey(s, key)).toThrow(RangeError);
    const withHash = sit({ id: "s" });
    expect(caseByKey(withHash, "s#0").params).toEqual({ a: 0, b: 0 });
  });
});
