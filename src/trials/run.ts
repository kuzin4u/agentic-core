import { canonicalJson } from "../canonical.js";
import { outcomeMatches, type TrialOutcome, type TrialParams, type TrialSituation, type TrialsCode } from "./types.js";
import { TrialError, caseByKey, expandCases, ruleFor, type TrialCase, type TrialMode } from "./grid.js";

/** Ответ стенда «вариант не умею» (К19 п. 2). `Symbol.for` — совпадает и у двух копий пакета в одном процессе. */
export const TRIAL_UNSUPPORTED: unique symbol = Symbol.for("agentic-core.trials.unsupported") as never;

export interface TrialRunInput {
  readonly situation: string;
  readonly refs: readonly string[];
  readonly key: string;
  readonly params: TrialParams;
  /** `chosen` — принятое решение, иначе имя отклонённого варианта из `rejected`. */
  readonly variant: string;
  /** Отменяется по `timeoutMs`; стенд может прервать работу. */
  readonly signal: AbortSignal;
}

/** Порт стенда у потребителя: параметры → свои вызовы, ответ → исход. Чистое состояние на каждый случай — забота стенда. */
export interface TrialStand {
  run(input: TrialRunInput): Promise<TrialOutcome | typeof TRIAL_UNSUPPORTED>;
}

export interface TrialRunOptions {
  readonly maxCases?: number;
  /** Предел на один вызов стенда, мс; по умолчанию 10 000. */
  readonly timeoutMs?: number;
  /** Режим «отклонённый вариант обязан провалиться» (п. 4); по умолчанию включён. */
  readonly rejected?: boolean;
}

export interface TrialFailure {
  readonly code: TrialsCode;
  readonly situation: string;
  readonly refs: readonly string[];
  /** Ключ случая; у отказа по ситуации целиком (`TRIALS_REJECTED_PASSED` при `any`, развёртка) — `id` ситуации. */
  readonly key: string;
  readonly params?: TrialParams;
  readonly variant: string;
  readonly expected?: TrialOutcome;
  readonly actual?: unknown;
  readonly error?: string;
}

export interface TrialReport {
  readonly mode: TrialMode["mode"];
  readonly seed?: number;
  readonly situations: number;
  /** Случаев принятого решения; `passed` — из них совпавших. */
  readonly cases: number;
  readonly passed: number;
  /** Всех вызовов стенда, с отклонёнными вариантами. */
  readonly runs: number;
  readonly failures: readonly TrialFailure[];
}

export const DEFAULT_TIMEOUT_MS = 10_000;

type One = { actual: TrialOutcome } | { code: "TRIALS_UNSUPPORTED" | "TRIALS_STAND_ERROR" | "TRIALS_TIMEOUT"; error?: string };

async function runOne(stand: TrialStand, s: TrialSituation, c: TrialCase, variant: string, timeoutMs: number): Promise<One> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => { ctl.abort(); resolve("timeout"); }, timeoutMs); });
  try {
    const call = Promise.resolve().then(() => stand.run({ situation: s.id, refs: s.refs, key: c.key, params: c.params, variant, signal: ctl.signal }));
    const r = await Promise.race([call, timeout]);
    if (r === "timeout") return { code: "TRIALS_TIMEOUT" };
    if (r === TRIAL_UNSUPPORTED) return { code: "TRIALS_UNSUPPORTED" };
    return { actual: r };
  } catch (e) {
    return { code: "TRIALS_STAND_ERROR", error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Прогон каталога (К19 п. 2–4): случаи последовательно; для каждого — принятое решение, затем отклонённые варианты.
 * Отклонённый вариант при `must: "any"` обязан разойтись с ожидаемым хотя бы на одном случае, при `all` — на каждом;
 * неумение стенда или его ошибка — провал, а не пропуск.
 */
export async function runTrials(stand: TrialStand, situations: readonly TrialSituation[], mode: TrialMode, opts: TrialRunOptions = {}): Promise<TrialReport> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failures: TrialFailure[] = [];
  let cases = 0, passed = 0, runs = 0;
  for (const s of situations) {
    const base = { situation: s.id, refs: s.refs };
    let list: TrialCase[];
    try {
      list = expandCases(s, mode, opts);
    } catch (e) {
      failures.push({ ...base, code: e instanceof TrialError ? e.code : "TRIALS_PARAMS_EMPTY", key: s.id, variant: "chosen", error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const ready: TrialCase[] = [];
    for (const c of list) {
      cases++;
      if (c.expected === null) { failures.push({ ...base, code: "TRIALS_NO_EXPECT", key: c.key, params: c.params, variant: "chosen" }); continue; }
      ready.push(c);
      runs++;
      const r = await runOne(stand, s, c, "chosen", timeoutMs);
      if ("code" in r) failures.push({ ...base, code: r.code, key: c.key, params: c.params, variant: "chosen", expected: c.expected, ...(r.error === undefined ? {} : { error: r.error }) });
      else if (outcomeMatches(c.expected, r.actual)) passed++;
      else failures.push({ ...base, code: "TRIALS_MISMATCH", key: c.key, params: c.params, variant: "chosen", expected: c.expected, actual: r.actual });
    }
    if (opts.rejected === false) continue;
    for (const v of s.rejected) {
      let diverged = 0;
      let broken = false;
      for (const c of ready) {
        runs++;
        const r = await runOne(stand, s, c, v.variant, timeoutMs);
        const expected = c.expected as TrialOutcome;
        if ("code" in r) {
          const code = r.code === "TRIALS_UNSUPPORTED" ? "TRIALS_REJECTED_UNSUPPORTED" : r.code;
          failures.push({ ...base, code, key: c.key, params: c.params, variant: v.variant, expected, ...(r.error === undefined ? {} : { error: r.error }) });
          broken = true;
          break;
        }
        if (!outcomeMatches(expected, r.actual)) diverged++;
        else if (v.must === "all") failures.push({ ...base, code: "TRIALS_REJECTED_PASSED", key: c.key, params: c.params, variant: v.variant, expected, actual: r.actual });
      }
      if (!broken && (v.must ?? "any") === "any" && diverged === 0) failures.push({ ...base, code: "TRIALS_REJECTED_PASSED", key: s.id, variant: v.variant });
    }
  }
  return { mode: mode.mode, ...(mode.mode === "sample" ? { seed: mode.seed } : {}), situations: situations.length, cases, passed, runs, failures };
}

export interface TrialReplay {
  readonly key: string;
  readonly params: TrialParams;
  readonly variant: string;
  readonly expected: TrialOutcome | null;
  readonly actual?: unknown;
  /** Исход совпал с ожидаемым по решению (для отклонённого варианта совпадение — признак пустого испытания). */
  readonly matched: boolean;
  /** Стенд не ответил исходом: не умеет, бросил исключение, превысил предел. */
  readonly code?: "TRIALS_UNSUPPORTED" | "TRIALS_STAND_ERROR" | "TRIALS_TIMEOUT";
  readonly error?: string;
}

/**
 * Повтор одного случая (К19 п. 3) по ключу из отчёта, без зерна. Если ситуация изменилась с прогона,
 * передайте `params` из отчёта — тогда ключ берётся как есть, а параметры не пересчитываются.
 */
export async function replayCase(stand: TrialStand, s: TrialSituation, key: string, opts: { variant?: string; params?: TrialParams; timeoutMs?: number } = {}): Promise<TrialReplay> {
  const variant = opts.variant ?? "chosen";
  const c: TrialCase = opts.params === undefined
    ? caseByKey(s, key)
    : { situation: s.id, key, index: -1, params: opts.params, expected: ruleFor(s, opts.params)?.outcome ?? null };
  const r = await runOne(stand, s, c, variant, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if ("code" in r) return { key, params: c.params, variant, expected: c.expected, matched: false, code: r.code, ...(r.error === undefined ? {} : { error: r.error }) };
  return { key, params: c.params, variant, expected: c.expected, actual: r.actual, matched: c.expected !== null && outcomeMatches(c.expected, r.actual) };
}

/** Одна техническая строка для сообщения теста: код, ссылки, ключ, вариант, параметры, ожидаемое и фактическое. */
export function formatTrialFailure(f: TrialFailure): string {
  const j = (v: unknown) => { try { return canonicalJson(v); } catch { return String(v); } };
  const parts = [f.code, f.refs.join(","), f.key, `variant=${f.variant}`];
  if (f.params !== undefined) parts.push(`params=${j(f.params)}`);
  if (f.expected !== undefined) parts.push(`expected=${j(f.expected)}`);
  if (f.actual !== undefined) parts.push(`actual=${j(f.actual)}`);
  if (f.error !== undefined) parts.push(`error=${f.error}`);
  return parts.join(" ");
}
