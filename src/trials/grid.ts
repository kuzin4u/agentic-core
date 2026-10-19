import { jsonKey, type TrialJson, type TrialParams, type TrialRule, type TrialSituation } from "./types.js";

// Нумерация сетки (К19 п. 3): ключи — в порядке canonicalJson (sort() по единицам UTF-16), значения — в порядке
// объявления; номер — смешанная система счисления, первый ключ — старший разряд.

export function paramKeys(s: TrialSituation): string[] {
  return Object.keys(s.params).sort();
}

/** Размер сетки; больше `Number.MAX_SAFE_INTEGER` — `Infinity`. */
export function gridSizeOf(s: TrialSituation): number {
  let size = 1;
  for (const k of paramKeys(s)) {
    size *= (s.params[k] ?? []).length;
    if (size > Number.MAX_SAFE_INTEGER) return Infinity;
  }
  return size;
}

export function paramsAt(s: TrialSituation, index: number): TrialParams {
  const keys = paramKeys(s);
  const out: Record<string, TrialJson> = {};
  let rest = index;
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i] as string;
    const dom = s.params[k] ?? [];
    out[k] = dom[rest % dom.length] as TrialJson;
    rest = Math.floor(rest / dom.length);
  }
  // Ключи — в порядке сетки, а не в обратном.
  return Object.fromEntries(keys.map((k) => [k, out[k] as TrialJson]));
}

export function isExcluded(s: TrialSituation, params: TrialParams): boolean {
  return (s.exclude ?? []).some((e) => Object.entries(e).every(([k, v]) => jsonKey(params[k]) === jsonKey(v)));
}

export function ruleFor(s: TrialSituation, params: TrialParams): TrialRule | undefined {
  return s.expect.find((r) => r.when === undefined
    || Object.entries(r.when).every(([k, vs]) => vs.some((v) => jsonKey(v) === jsonKey(params[k]))));
}

/** Ошибка развёртки ситуации в случаи: код — `TRIALS_*`. */
export class TrialError extends Error {
  constructor(readonly code: "TRIALS_GRID_TOO_LARGE" | "TRIALS_NO_EXPECT" | "TRIALS_PARAMS_EMPTY" | "TRIALS_RULE_KEY", readonly detail?: string) {
    super(detail === undefined ? code : `${code} ${detail}`);
    this.name = "TrialError";
  }
}

/** Генератор mulberry32 (К19 п. 3): 32 бита без знака на шаг. Смена алгоритма меняет случаи при том же зерне — только через /decision. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export type TrialMode = { readonly mode: "grid" } | { readonly mode: "sample"; readonly n: number; readonly seed: number };

export interface TrialCase {
  readonly situation: string;
  /** `<id>#<номер в сетке>`, от зерна не зависит. */
  readonly key: string;
  readonly index: number;
  readonly params: TrialParams;
  /** Ожидаемый исход по первому подходящему правилу; `null` — правила нет (ошибка каталога). */
  readonly expected: TrialRule["outcome"] | null;
}

export const DEFAULT_MAX_CASES = 1000;

function caseAt(s: TrialSituation, index: number): TrialCase {
  const params = paramsAt(s, index);
  return { situation: s.id, key: `${s.id}#${index}`, index, params, expected: ruleFor(s, params)?.outcome ?? null };
}

/**
 * Развёртка ситуации в случаи, по возрастанию номера. Сетка — все номера без `exclude`, больше `maxCases` — `TrialError`.
 * Выборка — `n` разных номеров (mulberry32 от `seed`, 53 бита на номер из двух шагов, без возврата); исключённые
 * сочетания выпадают и тянутся заново, не более `64·n + 1024` попыток — при почти целиком исключённой сетке случаев
 * может выйти меньше `n`. `n` не меньше размера сетки — полный перебор.
 */
export function expandCases(s: TrialSituation, mode: TrialMode, opts: { maxCases?: number } = {}): TrialCase[] {
  const max = opts.maxCases ?? DEFAULT_MAX_CASES;
  const size = gridSizeOf(s);
  if (mode.mode === "sample") {
    const { n, seed } = mode;
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("n");
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError("seed");
    if (n < size) {
      const next = mulberry32(seed);
      const picked = new Set<number>();
      for (let tries = 0; picked.size < n && tries < 64 * n + 1024; tries++) {
        const u = ((next() >>> 5) * 67108864 + (next() >>> 6)) / 9007199254740992; // [0, 1), 53 бита
        const index = Math.floor(u * size);
        if (!picked.has(index) && !isExcluded(s, paramsAt(s, index))) picked.add(index);
      }
      return [...picked].sort((x, y) => x - y).map((i) => caseAt(s, i));
    }
  } else if (size > max) {
    throw new TrialError("TRIALS_GRID_TOO_LARGE", `${s.id} ${size} > ${max}`);
  }
  const out: TrialCase[] = [];
  for (let i = 0; i < size; i++) if (!isExcluded(s, paramsAt(s, i))) out.push(caseAt(s, i));
  return out;
}

/** Случай по ключу из отчёта, без зерна. Ключ чужой ситуации, номер вне сетки или исключённое сочетание — `RangeError`. */
export function caseByKey(s: TrialSituation, key: string): TrialCase {
  const at = key.lastIndexOf("#");
  const index = Number(key.slice(at + 1));
  if (at < 0 || key.slice(0, at) !== s.id || !/^(0|[1-9][0-9]*)$/.test(key.slice(at + 1)) || index >= gridSizeOf(s)) throw new RangeError("key");
  const c = caseAt(s, index);
  if (isExcluded(s, c.params)) throw new RangeError("key");
  return c;
}
