// Испытания ядра по своей области реестра (К19 п. 6): каталог, полнота, прогон сеткой и выборкой.
import { describe, it, expect } from "vitest";
import { checkCoverage, checkSituations, formatTrialFailure, runTrials, trialScope } from "../src/trials/index.js";
import { CORE_EXCLUSIONS, CORE_SITUATIONS, coreStand } from "./trials/core-catalog.js";

describe("К19: испытания ядра", () => {
  it("каталог годен", () => {
    expect(checkSituations(CORE_SITUATIONS)).toEqual([]);
  });

  it("полнота: каждый пункт agentic-core покрыт или вне испытаний с основанием", () => {
    expect(checkCoverage({ scope: trialScope("agentic-core"), situations: CORE_SITUATIONS, exclusions: CORE_EXCLUSIONS })).toEqual([]);
    expect(trialScope("agentic-core").length).toBe(20);
  });

  it("сетка: принятые решения проходят, отклонённые варианты проваливаются", async () => {
    const r = await runTrials(coreStand, CORE_SITUATIONS, { mode: "grid" });
    expect(r.failures.map(formatTrialFailure)).toEqual([]);
    expect(r.cases).toBe(r.passed);
    expect(r.cases).toBeGreaterThan(40);
  });

  it("выборка с зерном — то же без отказов", async () => {
    const r = await runTrials(coreStand, CORE_SITUATIONS, { mode: "sample", n: 6, seed: 19102026 });
    expect(r.failures.map(formatTrialFailure)).toEqual([]);
  });

  it("выборка может пропустить различающий случай — тогда отказ, а не молчание (К19 п. 4)", async () => {
    const kp8 = CORE_SITUATIONS.filter((s) => s.id === "КП-8.цена-после-согласования");
    const r = await runTrials(coreStand, kp8, { mode: "sample", n: 3, seed: 19102026 });
    // в выборку не попали ±1 — коридор 1 % на ±500 и 0 совпадает с решением
    expect(r.failures.map((f) => [f.code, f.variant])).toEqual([["TRIALS_REJECTED_PASSED", "коридор-1%"]]);
  });
});
