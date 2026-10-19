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
export {
  runTrials, replayCase, formatTrialFailure, TRIAL_UNSUPPORTED, DEFAULT_TIMEOUT_MS,
  type TrialStand, type TrialRunInput, type TrialRunOptions, type TrialFailure, type TrialReport, type TrialReplay,
} from "./run.js";
export { TRIAL_REPOS, type TrialRepo, type TrialFork, type TrialConflict, type TrialItem } from "./types.js";
export { TRIAL_FORKS, TRIAL_CONFLICTS, TRIAL_FORKS_SHA256, TRIAL_CONFLICTS_SHA256 } from "./registry.js";
export { TRIAL_ITEMS, trialScope, checkCoverage, type TrialExclusion, type TrialCoverageInput } from "./coverage.js";
