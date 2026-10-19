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

