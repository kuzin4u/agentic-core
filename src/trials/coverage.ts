import { TRIAL_EXCLUSION_BASES, filled, type TrialExclusionBasis, type TrialItem, type TrialProblem, type TrialRepo, type TrialSituation } from "./types.js";
import { TRIAL_CONFLICTS, TRIAL_FORKS } from "./registry.js";

/** Все пункты реестра: развилка `Р-N` → `РЗ-N`, конфликт `К-N` → `КП-N` (К19 п. 0). */
export const TRIAL_ITEMS: readonly TrialItem[] = [
  ...TRIAL_FORKS.map((f): TrialItem => ({ ref: `РЗ-${f.id.slice(2)}`, kind: "fork", title: f.question, repo: f.repo })),
  ...TRIAL_CONFLICTS.map((c): TrialItem => ({ ref: `КП-${c.id.slice(1)}`, kind: "conflict", title: c.title, repo: c.repo })),
];

/** Область репозитория: пункты, которые он обязан покрыть или вынести «вне испытаний». */
export function trialScope(repo: TrialRepo, items: readonly TrialItem[] = TRIAL_ITEMS): TrialItem[] {
  return items.filter((i) => i.repo === repo);
}

/** «Вне испытаний» (К19 п. 5): основание из закрытого перечня, причина и где записано — непусты. */
export interface TrialExclusion {
  readonly ref: string;
  readonly basis: TrialExclusionBasis;
  readonly reason: string;
  readonly recordedIn: string;
}

export interface TrialCoverageInput {
  /** Своя область — `trialScope(repo)`. */
  readonly scope: readonly TrialItem[];
  readonly situations: readonly TrialSituation[];
  readonly exclusions: readonly TrialExclusion[];
  /** Весь реестр для `TRIALS_UNKNOWN_REF`; по умолчанию `TRIAL_ITEMS`. */
  readonly registry?: readonly TrialItem[];
}

/**
 * Полнота (К19 п. 5): каждый пункт `scope` покрыт ситуацией или стоит в `exclusions`, но не то и другое сразу.
 * Ссылки ситуаций и исключений — из реестра; ситуации могут покрывать и чужие пункты (сквозные), обязательна своя область.
 * Пустой массив — область покрыта.
 */
export function checkCoverage(input: TrialCoverageInput): TrialProblem[] {
  const known = new Set((input.registry ?? TRIAL_ITEMS).map((i) => i.ref));
  const out: TrialProblem[] = [];
  const covered = new Set<string>();
  for (const s of input.situations) {
    for (const ref of Array.isArray(s.refs) ? s.refs : []) {
      if (!known.has(ref)) out.push({ code: "TRIALS_UNKNOWN_REF", situation: s.id, ref });
      covered.add(ref);
    }
  }
  const excluded = new Set<string>();
  for (const e of input.exclusions) {
    if (!known.has(e.ref)) out.push({ code: "TRIALS_UNKNOWN_REF", ref: e.ref, field: "exclusions" });
    if (!TRIAL_EXCLUSION_BASES.includes(e.basis)) out.push({ code: "TRIALS_EXCLUSION_BASIS", ref: e.ref, field: "basis" });
    if (!filled(e.reason)) out.push({ code: "TRIALS_EXCLUSION_REASON", ref: e.ref, field: "reason" });
    if (!filled(e.recordedIn)) out.push({ code: "TRIALS_EXCLUSION_REASON", ref: e.ref, field: "recordedIn" });
    if (covered.has(e.ref)) out.push({ code: "TRIALS_COVERED_AND_EXCLUDED", ref: e.ref });
    excluded.add(e.ref);
  }
  for (const i of input.scope) {
    if (!covered.has(i.ref) && !excluded.has(i.ref)) out.push({ code: "TRIALS_UNCOVERED", ref: i.ref });
  }
  return out;
}
