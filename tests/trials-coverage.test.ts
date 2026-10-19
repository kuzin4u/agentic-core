import { describe, it, expect } from "vitest";
import { checkCoverage, trialScope, TRIAL_ITEMS, type TrialItem, type TrialSituation, type TrialExclusion } from "../src/trials/index.js";

const registry: TrialItem[] = [
  { ref: "РЗ-1", kind: "fork", title: "a", repo: "agentic-core" },
  { ref: "РЗ-2", kind: "fork", title: "b", repo: "agentic-core" },
  { ref: "КП-8", kind: "conflict", title: "c", repo: "agentic-core" },
  { ref: "КП-1", kind: "conflict", title: "d", repo: "agentic-ps-platform" },
];
const sit = (id: string, refs: string[]): TrialSituation => ({ id, refs, params: {}, expect: [{ outcome: {} }], rejected: [], rejectedNone: { basis: "process", reason: "тест" } });
const ex = (ref: string, over: Partial<Record<keyof TrialExclusion, unknown>> = {}): TrialExclusion =>
  ({ ref, basis: "process", reason: "процесс, не код", recordedIn: "CLAUDE.md", ...over } as TrialExclusion);
const scope = trialScope("agentic-core", registry);

describe("К19 п. 5: полнота", () => {
  it("область — пункты своего репозитория", () => {
    expect(scope.map((i) => i.ref)).toEqual(["РЗ-1", "РЗ-2", "КП-8"]);
  });

  it("всё покрыто или вне испытаний — без замечаний; чужой пункт покрывать можно", () => {
    expect(checkCoverage({ scope, registry, situations: [sit("s1", ["РЗ-1", "КП-8", "КП-1"])], exclusions: [ex("РЗ-2")] })).toEqual([]);
  });

  it("непокрытый пункт", () => {
    expect(checkCoverage({ scope, registry, situations: [sit("s1", ["РЗ-1"])], exclusions: [] })).toEqual([
      { code: "TRIALS_UNCOVERED", ref: "РЗ-2" }, { code: "TRIALS_UNCOVERED", ref: "КП-8" },
    ]);
  });

  it("неизвестная ссылка в ситуации и в исключении", () => {
    expect(checkCoverage({ scope, registry, situations: [sit("s1", ["РЗ-1", "КП-8", "РЗ-99"])], exclusions: [ex("РЗ-2"), ex("КП-77")] })).toEqual([
      { code: "TRIALS_UNKNOWN_REF", situation: "s1", ref: "РЗ-99" },
      { code: "TRIALS_UNKNOWN_REF", ref: "КП-77", field: "exclusions" },
    ]);
  });

  it("основание вне перечня, пустая причина или место записи", () => {
    expect(checkCoverage({ scope, registry, situations: [sit("s1", ["РЗ-1"])], exclusions: [ex("РЗ-2", { basis: "later" }), ex("КП-8", { reason: " ", recordedIn: "" })] })).toEqual([
      { code: "TRIALS_EXCLUSION_BASIS", ref: "РЗ-2", field: "basis" },
      { code: "TRIALS_EXCLUSION_REASON", ref: "КП-8", field: "reason" },
      { code: "TRIALS_EXCLUSION_REASON", ref: "КП-8", field: "recordedIn" },
    ]);
  });

  it("покрыт и вне испытаний одновременно", () => {
    expect(checkCoverage({ scope, registry, situations: [sit("s1", ["РЗ-1", "РЗ-2", "КП-8"])], exclusions: [ex("РЗ-2")] })).toEqual([
      { code: "TRIALS_COVERED_AND_EXCLUDED", ref: "РЗ-2" },
    ]);
  });

  it("реестр: Р-N → РЗ-N, К-N → КП-N; области репозиториев не пересекаются и покрывают весь реестр", () => {
    expect(TRIAL_ITEMS.length).toBe(96);
    expect(TRIAL_ITEMS[0]).toMatchObject({ ref: "РЗ-1", kind: "fork", repo: "agentic-core" });
    expect(TRIAL_ITEMS.find((i) => i.ref === "КП-8")).toMatchObject({ kind: "conflict", title: "Цена изменилась после согласования", repo: "agentic-core" });
    const sizes = (["agentic-core", "agentic-ps-platform", "agentic-buyer-ref", "nsvr-settlement", "marketplace-api"] as const).map((r) => trialScope(r).length);
    expect(sizes).toEqual([20, 47, 29, 0, 0]);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(TRIAL_ITEMS.length);
  });
});
