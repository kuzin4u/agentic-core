import { TRIAL_EXCLUSION_BASES, TRIAL_REF, filled, isRecord, jsonKey, type TrialExclusionBasis, type TrialProblem, type TrialSituation, type TrialsCode } from "./types.js";
import { gridSizeOf, isExcluded, paramsAt, ruleFor } from "./grid.js";

/** Проверка набора `{ имя: значение }` или `{ имя: [значения] }` по пространству параметров. */
function checkKeys(s: TrialSituation, rec: unknown, lists: boolean): boolean {
  if (!isRecord(rec)) return false;
  for (const [k, v] of Object.entries(rec)) {
    const dom = Object.hasOwn(s.params, k) ? s.params[k] : undefined;
    if (!Array.isArray(dom)) return false;
    const domKeys = new Set(dom.map(jsonKey));
    const vals: unknown[] = lists ? (Array.isArray(v) && v.length > 0 ? v : [undefined]) : [v];
    if (!vals.every((x) => { const j = jsonKey(x); return j !== null && domKeys.has(j); })) return false;
  }
  return true;
}

/** Сетки больше этого `checkSituations` не перебирает: сочетание без правила поймает прогон (`TRIALS_NO_EXPECT`). */
export const CHECK_ENUMERATE_LIMIT = 10_000;

/**
 * Проверка каталога до прогона (К19 п. 5). Пустой массив — каталог годен. Ситуации проверяются и тогда,
 * когда пришли не из TypeScript (JSON).
 */
export function checkSituations(situations: readonly TrialSituation[]): TrialProblem[] {
  const out: TrialProblem[] = [];
  const seen = new Set<string>();
  situations.forEach((s, i) => {
    const raw = s as unknown;
    if (!isRecord(raw)) { out.push({ code: "TRIALS_ID_DUPLICATE", situation: `#${i}` }); return; }
    const id = filled(s.id) && !s.id.includes("#") ? s.id : `#${i}`;
    if (id !== s.id || seen.has(id)) out.push({ code: "TRIALS_ID_DUPLICATE", situation: id, field: "id" });
    seen.add(id);
    const p = (code: TrialsCode, field: string) => out.push({ code, situation: id, field });

    if (!Array.isArray(s.refs) || s.refs.length === 0 || !s.refs.every((r) => typeof r === "string" && TRIAL_REF.test(r))) p("TRIALS_REF_INVALID", "refs");

    let paramsOk = isRecord(s.params);
    if (!paramsOk) p("TRIALS_PARAMS_EMPTY", "params");
    else for (const [k, vs] of Object.entries(s.params)) {
      if (!Array.isArray(vs) || vs.length === 0 || vs.some((v) => jsonKey(v) === null)) { p("TRIALS_PARAMS_EMPTY", `params.${k}`); paramsOk = false; }
    }

    if (s.exclude !== undefined && (!Array.isArray(s.exclude) || (paramsOk && !s.exclude.every((e) => checkKeys(s, e, false))))) p("TRIALS_RULE_KEY", "exclude");

    const rules: unknown = s.expect;
    let rulesOk = Array.isArray(rules) && rules.length > 0;
    if (Array.isArray(rules)) rules.forEach((r: unknown, j) => {
      if (!isRecord(r) || !isRecord(r.outcome) || jsonKey(r.outcome) === null) { p("TRIALS_NO_EXPECT", `expect.${j}`); rulesOk = false; return; }
      if (r.when !== undefined && paramsOk && !checkKeys(s, r.when, true)) { p("TRIALS_RULE_KEY", `expect.${j}.when`); rulesOk = false; }
    });
    else p("TRIALS_NO_EXPECT", "expect");
    if (Array.isArray(rules) && rules.length === 0) p("TRIALS_NO_EXPECT", "expect");

    // Каждое допустимое сочетание — с правилом; перебор только для небольших сеток.
    if (paramsOk && rulesOk) {
      const size = gridSizeOf(s);
      if (size <= CHECK_ENUMERATE_LIMIT) {
        for (let n = 0; n < size; n++) {
          const params = paramsAt(s, n);
          if (!isExcluded(s, params) && ruleFor(s, params) === undefined) { p("TRIALS_NO_EXPECT", `${s.id}#${n}`); break; }
        }
      }
    }

    const rej: unknown = s.rejected;
    if (!Array.isArray(rej)) p("TRIALS_REJECTED_MISSING", "rejected");
    else if (rej.length === 0) {
      const none: unknown = s.rejectedNone;
      if (!isRecord(none)) p("TRIALS_REJECTED_MISSING", "rejectedNone");
      else {
        if (!TRIAL_EXCLUSION_BASES.includes(none.basis as TrialExclusionBasis)) p("TRIALS_EXCLUSION_BASIS", "rejectedNone.basis");
        if (!filled(none.reason)) p("TRIALS_EXCLUSION_REASON", "rejectedNone.reason");
      }
    } else {
      const names = new Set<string>();
      rej.forEach((r: unknown, j) => {
        const bad = !isRecord(r) || !filled(r.variant) || r.variant === "chosen" || names.has(r.variant as string)
          || !filled(r.note) || (r.must !== undefined && r.must !== "any" && r.must !== "all");
        if (bad) p("TRIALS_REJECTED_MISSING", `rejected.${j}`);
        if (isRecord(r) && typeof r.variant === "string") names.add(r.variant);
      });
    }
  });
  return out;
}
