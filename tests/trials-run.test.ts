import { describe, it, expect } from "vitest";
import { runTrials, replayCase, formatTrialFailure, TRIAL_UNSUPPORTED, type TrialStand, type TrialSituation, type TrialRunInput } from "../src/trials/index.js";

// Игрушечный стенд: цена изменилась на `delta`; принятое решение — строгое равенство, отклонённые — допуск и «как принятое».
const price: TrialSituation = {
  id: "price", refs: ["КП-8"], params: { delta: [-10, 0, 10], qty: [1, 2] },
  expect: [{ when: { delta: [0] }, outcome: { result: "ok" } }, { outcome: { result: "refuse" } }],
  rejected: [{ variant: "tolerance", note: "коридор отклонения цены" }],
};

const calls: TrialRunInput[] = [];
const stand: TrialStand = {
  async run(input) {
    calls.push(input);
    const d = input.params.delta as number;
    switch (input.variant) {
      case "chosen": return { result: d === 0 ? "ok" : "refuse", at: Date.now() };
      case "tolerance": return { result: Math.abs(d) <= 10 ? "ok" : "refuse" };
      case "same": return { result: d === 0 ? "ok" : "refuse" };
      case "up-only": return { result: d <= 0 ? "ok" : "refuse" };
      case "throws": throw new Error("стенд упал");
      case "hangs": return new Promise(() => {});
      default: return TRIAL_UNSUPPORTED;
    }
  },
};

describe("К19 п. 2, 4: прогон против стенда и режим «отклонённый обязан провалиться»", () => {
  it("принятое решение проходит, отклонённый вариант расходится — отчёт без отказов", async () => {
    calls.length = 0;
    const r = await runTrials(stand, [price], { mode: "grid" });
    expect(r).toEqual({ mode: "grid", situations: 1, cases: 6, passed: 6, runs: 12, failures: [] });
    expect(calls[0]).toMatchObject({ situation: "price", refs: ["КП-8"], key: "price#0", params: { delta: -10, qty: 1 }, variant: "chosen" });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("выборка: зерно — в отчёте", async () => {
    const r = await runTrials(stand, [price], { mode: "sample", n: 3, seed: 9 });
    expect(r).toMatchObject({ mode: "sample", seed: 9, cases: 3, passed: 3, runs: 6, failures: [] });
  });

  it("несовпадение исхода — TRIALS_MISMATCH с параметрами, ожидаемым и фактическим", async () => {
    const wrong: TrialSituation = { ...price, expect: [{ outcome: { result: "ok" } }], rejected: [], rejectedNone: { basis: "process", reason: "тест" } };
    const r = await runTrials(stand, [wrong], { mode: "grid" });
    expect(r.passed).toBe(2);
    expect(r.failures.length).toBe(4);
    expect(r.failures[0]).toMatchObject({ code: "TRIALS_MISMATCH", situation: "price", refs: ["КП-8"], key: "price#0", params: { delta: -10, qty: 1 }, variant: "chosen", expected: { result: "ok" }, actual: { result: "refuse" } });
  });

  it("отклонённый вариант, совпавший с принятым на всех случаях, — TRIALS_REJECTED_PASSED", async () => {
    const r = await runTrials(stand, [{ ...price, rejected: [{ variant: "same", note: "n" }] }], { mode: "grid" });
    expect(r.failures).toEqual([{ code: "TRIALS_REJECTED_PASSED", situation: "price", refs: ["КП-8"], key: "price", variant: "same" }]);
  });

  it("must: all — каждый совпавший случай отдельно", async () => {
    const r = await runTrials(stand, [{ ...price, rejected: [{ variant: "up-only", note: "n", must: "all" }] }], { mode: "grid" });
    // up-only расходится только при delta = -10
    expect(r.failures.map((f) => [f.code, f.key])).toEqual([
      ["TRIALS_REJECTED_PASSED", "price#2"], ["TRIALS_REJECTED_PASSED", "price#3"],
      ["TRIALS_REJECTED_PASSED", "price#4"], ["TRIALS_REJECTED_PASSED", "price#5"],
    ]);
    const any = await runTrials(stand, [{ ...price, rejected: [{ variant: "up-only", note: "n" }] }], { mode: "grid" });
    expect(any.failures).toEqual([]);
  });

  it("стенд не умеет отклонённый вариант — провал, не пропуск; один отказ на вариант", async () => {
    const r = await runTrials(stand, [{ ...price, rejected: [{ variant: "nope", note: "n" }] }], { mode: "grid" });
    expect(r.failures).toEqual([{ code: "TRIALS_REJECTED_UNSUPPORTED", situation: "price", refs: ["КП-8"], key: "price#0", params: { delta: -10, qty: 1 }, variant: "nope", expected: { result: "refuse" } }]);
  });

  it("режим выключен — отклонённые не прогоняются", async () => {
    const r = await runTrials(stand, [{ ...price, rejected: [{ variant: "same", note: "n" }] }], { mode: "grid" }, { rejected: false });
    expect(r).toMatchObject({ runs: 6, failures: [] });
  });

  it("ошибка стенда, неумение, предел времени", async () => {
    const bad = (variant: string): TrialStand => ({ run: (i) => stand.run({ ...i, variant }) });
    const one: TrialSituation = { ...price, params: { delta: [0] }, rejected: [], rejectedNone: { basis: "process", reason: "тест" } };
    expect((await runTrials(bad("throws"), [one], { mode: "grid" })).failures).toEqual([
      { code: "TRIALS_STAND_ERROR", situation: "price", refs: ["КП-8"], key: "price#0", params: { delta: 0 }, variant: "chosen", expected: { result: "ok" }, error: "стенд упал" },
    ]);
    expect((await runTrials(bad("nope"), [one], { mode: "grid" })).failures[0]?.code).toBe("TRIALS_UNSUPPORTED");
    let aborted = false;
    const hang: TrialStand = { run: (i) => { i.signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {}); } };
    expect((await runTrials(hang, [one], { mode: "grid" }, { timeoutMs: 20 })).failures[0]?.code).toBe("TRIALS_TIMEOUT");
    expect(aborted).toBe(true);
    // синхронное исключение стенда — тоже отказ, а не падение прогона
    const sync: TrialStand = { run: () => { throw new TypeError("sync"); } };
    expect((await runTrials(sync, [one], { mode: "grid" })).failures[0]).toMatchObject({ code: "TRIALS_STAND_ERROR", error: "sync" });
  });

  it("сочетание без правила и слишком большая сетка — отказы в отчёте, прогон продолжается", async () => {
    const noRule: TrialSituation = { ...price, id: "n", expect: [{ when: { delta: [0] }, outcome: { result: "ok" } }] };
    const big: TrialSituation = { ...price, id: "big", params: { a: Array.from({ length: 40 }, (_, i) => i), b: Array.from({ length: 40 }, (_, i) => i) } };
    const r = await runTrials(stand, [noRule, big, price], { mode: "grid" });
    expect(r.failures.filter((f) => f.situation === "n").map((f) => [f.code, f.key])).toEqual([
      ["TRIALS_NO_EXPECT", "n#0"], ["TRIALS_NO_EXPECT", "n#1"], ["TRIALS_NO_EXPECT", "n#4"], ["TRIALS_NO_EXPECT", "n#5"],
      // отклонённый идёт только по случаям с ожидаемым исходом (delta = 0) — там допуск совпадает с решением
      ["TRIALS_REJECTED_PASSED", "n"],
    ]);
    expect(r.failures.find((f) => f.situation === "big")).toMatchObject({ code: "TRIALS_GRID_TOO_LARGE", key: "big", variant: "chosen" });
    expect(r.failures.some((f) => f.situation === "price")).toBe(false);
  });

  it("повтор случая по ключу: принятое и отклонённый вариант; явные параметры", async () => {
    expect(await replayCase(stand, price, "price#2")).toMatchObject({ key: "price#2", params: { delta: 0, qty: 1 }, variant: "chosen", expected: { result: "ok" }, matched: true });
    expect(await replayCase(stand, price, "price#0", { variant: "tolerance" })).toMatchObject({ matched: false, actual: { result: "ok" } });
    expect(await replayCase(stand, price, "old#7", { params: { delta: 10, qty: 3 } })).toMatchObject({ key: "old#7", expected: { result: "refuse" }, matched: true });
    expect(await replayCase(stand, price, "price#0", { variant: "nope" })).toMatchObject({ code: "TRIALS_UNSUPPORTED", matched: false });
    await expect(replayCase(stand, price, "price#6")).rejects.toThrow(RangeError);
  });

  it("строка отказа — техническая, с ключом для повтора", () => {
    expect(formatTrialFailure({ code: "TRIALS_MISMATCH", situation: "price", refs: ["КП-8", "РЗ-5"], key: "price#0", params: { qty: 1, delta: -10 }, variant: "chosen", expected: { result: "ok" }, actual: { result: "refuse" } }))
      .toBe('TRIALS_MISMATCH КП-8,РЗ-5 price#0 variant=chosen params={"delta":-10,"qty":1} expected={"result":"ok"} actual={"result":"refuse"}');
  });
});
