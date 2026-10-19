import { canonicalJson } from "../canonical.js";

/** Формат ситуации испытаний (К19 п. 1): только данные, без функций — ситуацию можно хранить в JSON. */

export type TrialJson = null | boolean | number | string | readonly TrialJson[] | { readonly [k: string]: TrialJson };
/** Исход: объект JSON; сравнение по подмножеству ключей (`outcomeMatches`). */
export type TrialOutcome = { readonly [k: string]: TrialJson };
/** Значения параметров одного случая. */
export type TrialParams = { readonly [name: string]: TrialJson };

/** Основания «вне испытаний» (К19 п. 5): юридическое, проверяется на пилоте, внешнее согласование, процесс — не код. */
export type TrialExclusionBasis = "legal" | "pilot" | "external" | "process";
export const TRIAL_EXCLUSION_BASES: readonly TrialExclusionBasis[] = ["legal", "pilot", "external", "process"];

export interface TrialBasis { readonly basis: TrialExclusionBasis; readonly reason: string }

/** Правило ожидаемого исхода: подходит, если значение каждого параметра из `when` — в его списке; без `when` — всегда. */
export interface TrialRule {
  readonly when?: { readonly [name: string]: readonly TrialJson[] };
  readonly outcome: TrialOutcome;
}

/** Отклонённый вариант решения: `variant` — имя для стенда, `note` — какой вариант реестра. */
export interface TrialRejected {
  readonly variant: string;
  readonly note: string;
  /** `any` (по умолчанию) — исход расходится с ожидаемым хотя бы на одном случае; `all` — на каждом. */
  readonly must?: "any" | "all";
}

export interface TrialSituation {
  /** Уникален в каталоге, без `#` (ключ случая — `<id>#<номер>`). */
  readonly id: string;
  /** Непустой список `РЗ-N` / `КП-N`. */
  readonly refs: readonly string[];
  readonly params: { readonly [name: string]: readonly TrialJson[] };
  /** Недопустимые сочетания: частичные наборы значений. */
  readonly exclude?: readonly TrialParams[];
  /** Первое подходящее правило. */
  readonly expect: readonly TrialRule[];
  readonly rejected: readonly TrialRejected[];
  /** Обязателен при пустом `rejected`: почему отклонённый вариант не прогоняется. */
  readonly rejectedNone?: TrialBasis;
}

/** Коды испытаний, без текста; не реестр `/diag` — не отказы обмена (К19 п. 5). */
export type TrialsCode =
  // каталог (`checkSituations`)
  | "TRIALS_ID_DUPLICATE"        // повтор `id`, пустой `id` или `id` с `#`
  | "TRIALS_REF_INVALID"         // `refs` пуст или ссылка не `РЗ-N` / `КП-N`
  | "TRIALS_PARAMS_EMPTY"        // у параметра нет значений или значение не JSON
  | "TRIALS_RULE_KEY"            // ключ `when` или `exclude` не из `params`, значение не из его списка
  | "TRIALS_NO_EXPECT"           // нет правил, исход не объект JSON или сочетание без подходящего правила
  | "TRIALS_REJECTED_MISSING"    // нет отклонённых вариантов без `rejectedNone`, пустое или повторное имя, `must` вне перечня
  | "TRIALS_GRID_TOO_LARGE"      // сетка больше `maxCases`
  // прогон (`runTrials`)
  | "TRIALS_MISMATCH"
  | "TRIALS_UNSUPPORTED"
  | "TRIALS_STAND_ERROR"
  | "TRIALS_TIMEOUT"
  | "TRIALS_REJECTED_PASSED"     // отклонённый вариант дал ожидаемый по решению исход — испытание не различает решения
  | "TRIALS_REJECTED_UNSUPPORTED"
  // полнота (`checkCoverage`)
  | "TRIALS_UNCOVERED"
  | "TRIALS_UNKNOWN_REF"
  | "TRIALS_EXCLUSION_BASIS"
  | "TRIALS_EXCLUSION_REASON"
  | "TRIALS_COVERED_AND_EXCLUDED";

export const TRIALS_CODES: readonly TrialsCode[] = [
  "TRIALS_ID_DUPLICATE", "TRIALS_REF_INVALID", "TRIALS_PARAMS_EMPTY", "TRIALS_RULE_KEY", "TRIALS_NO_EXPECT",
  "TRIALS_REJECTED_MISSING", "TRIALS_GRID_TOO_LARGE",
  "TRIALS_MISMATCH", "TRIALS_UNSUPPORTED", "TRIALS_STAND_ERROR", "TRIALS_TIMEOUT", "TRIALS_REJECTED_PASSED",
  "TRIALS_REJECTED_UNSUPPORTED",
  "TRIALS_UNCOVERED", "TRIALS_UNKNOWN_REF", "TRIALS_EXCLUSION_BASIS", "TRIALS_EXCLUSION_REASON",
  "TRIALS_COVERED_AND_EXCLUDED",
];

/** `situation` — `id` ситуации или её номер в каталоге (`#3`), если `id` негоден; `field` — поле. */
export interface TrialProblem { code: TrialsCode; situation?: string; ref?: string; field?: string }

export const TRIAL_REF = /^(РЗ|КП)-[1-9][0-9]*$/;

export const filled = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Каноническая запись или `null`, если значение не JSON. */
export function jsonKey(v: unknown): string | null {
  try { return canonicalJson(v); } catch { return null; }
}

/** Исход по подмножеству: каждый ключ `expected` есть в `actual` и равен ему по `canonicalJson`. */
export function outcomeMatches(expected: TrialOutcome, actual: unknown): boolean {
  if (!isRecord(actual)) return false;
  for (const [k, v] of Object.entries(expected)) {
    if (!Object.hasOwn(actual, k)) return false;
    const a = jsonKey(actual[k]);
    if (a === null || a !== jsonKey(v)) return false;
  }
  return true;
}

// Реестр развилок и конфликтов (К19 п. 5): каждый пункт назначен ровно одному репозиторию.

export type TrialRepo = "agentic-core" | "agentic-ps-platform" | "agentic-buyer-ref" | "nsvr-settlement" | "marketplace-api";
export const TRIAL_REPOS: readonly TrialRepo[] = ["agentic-core", "agentic-ps-platform", "agentic-buyer-ref", "nsvr-settlement", "marketplace-api"];

/** Запись реестра развилок чата как есть: `id` — `Р-N` (ссылка в ситуациях — `РЗ-N`). */
export interface TrialFork {
  readonly id: string;
  readonly question: string;
  readonly chosen: string;
  readonly rejected: string;
  readonly decided_by: string;
  readonly review: string | null;
  readonly recorded_in: string;
  readonly repo: TrialRepo;
}

/** Конфликт пула (`29-konflikty.html` платформы): `id` — `К-N` источника (ссылка — `КП-N`); `repo` — назначение К19 п. 6. */
export interface TrialConflict {
  readonly id: string;
  readonly title: string;
  readonly stage: number;
  readonly status: string;
  readonly parties: string;
  readonly repo: TrialRepo;
}

/** Пункт полноты: `ref` — `РЗ-N` или `КП-N`. */
export interface TrialItem { readonly ref: string; readonly kind: "fork" | "conflict"; readonly title: string; readonly repo: TrialRepo }
