/** Матрица испытаний и эмулятор ситуаций (К19): формат ситуации, проверка каталога, сетка и выборка с зерном, прогон
 *  против стенда потребителя, полнота по реестру развилок и конфликтов; основной вход пакета их не реэкспортирует. */
export {
  TRIAL_EXCLUSION_BASES, TRIALS_CODES, TRIAL_REF, outcomeMatches, jsonKey,
  type TrialJson, type TrialOutcome, type TrialParams, type TrialExclusionBasis, type TrialBasis, type TrialRule,
  type TrialRejected, type TrialSituation, type TrialsCode, type TrialProblem,
} from "./types.js";
export { checkSituations, CHECK_ENUMERATE_LIMIT } from "./check.js";
export { paramKeys, gridSizeOf, paramsAt, isExcluded, ruleFor } from "./grid.js";
export { mulberry32, expandCases, caseByKey, TrialError, DEFAULT_MAX_CASES, type TrialMode, type TrialCase } from "./grid.js";
