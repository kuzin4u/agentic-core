import { isCalendarDateTime } from "../iso-date.js";

/** Формат реестра кодов отказов (К17, CO-ДГ): запись, проверка полноты, действие по коду, отчёт самопроверки (п. 8); основной вход пакета их не реэкспортирует. */

/** Кто выдаёт код: ядро, Платформа по ПАО, Платформа на порту участника (ПИ), Платформа вне протокола, агент. */
export type DiagComponent = "core" | "pao" | "pi" | "platform" | "agent";
/** Кто ошибся или отказал. */
export type DiagSource = "agent" | "platform" | "bank" | "merchant" | "client" | "environment";
/** Что делает получатель; те же пять значений, что `retry` ПАО (`never` ↔ `stop`, `same_key` ↔ `retry_same_key`). */
export type DiagAction = "stop" | "retry_same_key" | "after_fix" | "after_human" | "new_key";

export const DIAG_COMPONENTS: readonly DiagComponent[] = ["core", "pao", "pi", "platform", "agent"];
export const DIAG_SOURCES: readonly DiagSource[] = ["agent", "platform", "bank", "merchant", "client", "environment"];
export const DIAG_ACTIONS: readonly DiagAction[] = ["stop", "retry_same_key", "after_fix", "after_human", "new_key"];

/** Постоянные строки по языкам, `ru` обязателен; без персональных данных, путей с идентификаторами, бренда и подстановок (К17 п. 6). */
export type DiagTexts = { readonly ru: string; readonly [lang: string]: string };

export interface DiagEntry {
  /** Машинное имя `^[A-Z][A-Z0-9_]*$`, равно ключу в реестре. */
  readonly code: string;
  readonly component: DiagComponent;
  /** Непустой, без повторов; несколько — когда источник неразличим (`MANDATE_NOT_FOUND`, РП34). */
  readonly source: readonly DiagSource[];
  readonly action: DiagAction;
  /** Что случилось и что делать, без технических слов. */
  readonly human: DiagTexts;
  /** Техническая причина и что проверить. */
  readonly operator: DiagTexts;
  /** Пункт норм или решение. */
  readonly norm: string;
  /** С какой версии действует: для `pao` — версия ПАО, для `core` — версия пакета. */
  readonly since: string;
}

export type DiagRegistry = Readonly<Record<string, DiagEntry>>;

/** Коды замечаний, без текста. */
export type DiagProblemCode =
  | "DIAG_MISSING"      // код из перечня без записи
  | "DIAG_EXTRA"        // запись без кода в перечне
  | "DIAG_KEY_MISMATCH" // `code` записи не равен ключу
  | "DIAG_CODE_FORMAT"  // код не `^[A-Z][A-Z0-9_]*$`
  | "DIAG_ENUM"         // `component`, `source` или `action` вне перечня; `source` пуст или с повтором
  | "DIAG_EMPTY";       // пустое поле или нет текста на языке из `langs`

/** `entry` — код, к которому относится замечание; `field` — поле записи. */
export interface DiagProblem { code: DiagProblemCode; entry: string; field?: string }

const CODE = /^[A-Z][A-Z0-9_]*$/;

const filled = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

function checkTexts(entry: string, field: "human" | "operator", t: unknown, langs: readonly string[], out: DiagProblem[]): void {
  if (typeof t !== "object" || t === null) { out.push({ code: "DIAG_EMPTY", entry, field }); return; }
  const rec = t as Record<string, unknown>;
  const bad = langs.some((l) => !Object.hasOwn(rec, l)) || Object.values(rec).some((v) => !filled(v));
  if (bad) out.push({ code: "DIAG_EMPTY", entry, field });
}

/**
 * Проверка полноты (К17 п. 3): каждому коду из `codes` — одна запись, лишних нет, поля заполнены и в перечнях.
 * Пустой массив — реестр полон. Записи проверяются и тогда, когда пришли не из TypeScript.
 */
export function checkDiagRegistry(codes: readonly string[], registry: DiagRegistry, opts: { langs?: readonly string[] } = {}): DiagProblem[] {
  const langs = opts.langs ?? ["ru"];
  const out: DiagProblem[] = [];
  const want = new Set(codes);
  for (const c of want) {
    if (!CODE.test(c)) out.push({ code: "DIAG_CODE_FORMAT", entry: c });
    if (!Object.hasOwn(registry, c)) out.push({ code: "DIAG_MISSING", entry: c });
  }
  for (const [key, e] of Object.entries(registry)) {
    if (!want.has(key)) out.push({ code: "DIAG_EXTRA", entry: key });
    if (typeof e !== "object" || e === null) { out.push({ code: "DIAG_EMPTY", entry: key }); continue; }
    if (e.code !== key) out.push({ code: "DIAG_KEY_MISMATCH", entry: key, field: "code" });
    if (!DIAG_COMPONENTS.includes(e.component)) out.push({ code: "DIAG_ENUM", entry: key, field: "component" });
    const src: unknown = e.source;
    if (!Array.isArray(src) || src.length === 0 || new Set(src).size !== src.length || !src.every((s) => DIAG_SOURCES.includes(s))) {
      out.push({ code: "DIAG_ENUM", entry: key, field: "source" });
    }
    if (!DIAG_ACTIONS.includes(e.action)) out.push({ code: "DIAG_ENUM", entry: key, field: "action" });
    checkTexts(key, "human", e.human, langs, out);
    checkTexts(key, "operator", e.operator, langs, out);
    if (!filled(e.norm)) out.push({ code: "DIAG_EMPTY", entry: key, field: "norm" });
    if (!filled(e.since)) out.push({ code: "DIAG_EMPTY", entry: key, field: "since" });
  }
  return out;
}

/** Действие по коду (К17 п. 4): код не из реестра или запись с действием вне перечня — `stop`. */
export function diagAction(registry: DiagRegistry, code: string): DiagAction {
  const a = Object.hasOwn(registry, code) ? registry[code]?.action : undefined;
  return a !== undefined && DIAG_ACTIONS.includes(a) ? a : "stop";
}

// Отчёт самопроверки при старте (К17 п. 8): «готов / не готов» и проверки с кодами из реестра, без свободного текста.

export type SelfCheckStatus = "ok" | "warn" | "fail";
export const SELF_CHECK_STATUSES: readonly SelfCheckStatus[] = ["ok", "warn", "fail"];

export interface SelfCheckItem {
  /** Машинное имя `^[a-z][a-z0-9_.]*$` (`db.migrations`), без повторов в отчёте. */
  readonly check: string;
  readonly status: SelfCheckStatus;
  /** Код из реестра: обязателен при `warn` и `fail`, запрещён при `ok`. */
  readonly code?: string;
}

export interface SelfCheckReport {
  readonly component: DiagComponent;
  readonly version: string;
  /** ISO 8601 UTC, как `Date.prototype.toISOString`. */
  readonly checked_at: string;
  /** Нет ни одного `fail`; `warn` готовность не снимает. */
  readonly ready: boolean;
  readonly checks: readonly SelfCheckItem[];
}

/** Сборка отчёта: `ready` вычисляется, `checked_at` — из `now`. Вход не проверяется — для этого `checkSelfCheckReport`. */
export function buildSelfCheckReport(component: DiagComponent, version: string, checks: readonly SelfCheckItem[], now: Date = new Date()): SelfCheckReport {
  return { component, version, checked_at: now.toISOString(), ready: !checks.some((c) => c.status === "fail"), checks: [...checks] };
}

export type SelfCheckProblemCode =
  | "SELFCHECK_EMPTY"          // `checks` пуст или не массив
  | "SELFCHECK_FIELD"          // `component`, `version`, `checked_at`, `ready` или `status` не по формату
  | "SELFCHECK_CHECK_FORMAT"   // `check` не `^[a-z][a-z0-9_.]*$`
  | "SELFCHECK_DUPLICATE"      // `check` повторяется
  | "SELFCHECK_CODE_MISSING"   // `warn` или `fail` без кода
  | "SELFCHECK_CODE_FORBIDDEN" // код при `ok`
  | "SELFCHECK_CODE_UNKNOWN"   // кода нет в реестре
  | "SELFCHECK_READY_MISMATCH"; // `ready` не равен «нет `fail`»

/** `check` — имя проверки, к которой относится замечание; `field` — поле отчёта или проверки. */
export interface SelfCheckProblem { code: SelfCheckProblemCode; check?: string; field?: string }

const CHECK = /^[a-z][a-z0-9_.]*$/;
// Форма; компоненты — по календарю (`isCalendarDateTime`, К20 п. 1).
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/**
 * Проверка отчёта (К17 п. 8): пустой массив — отчёт корректен. Реестр — свой или объединённый с ядерным;
 * `component` записей реестра с `component` отчёта не сверяется. Отчёт проверяется и тогда, когда пришёл не из TypeScript.
 */
export function checkSelfCheckReport(report: SelfCheckReport, registry: DiagRegistry): SelfCheckProblem[] {
  const out: SelfCheckProblem[] = [];
  if (typeof report !== "object" || report === null) return [{ code: "SELFCHECK_FIELD" }];
  if (!DIAG_COMPONENTS.includes(report.component)) out.push({ code: "SELFCHECK_FIELD", field: "component" });
  if (!filled(report.version)) out.push({ code: "SELFCHECK_FIELD", field: "version" });
  const at: unknown = report.checked_at;
  if (typeof at !== "string" || !UTC.test(at) || !isCalendarDateTime(at)) out.push({ code: "SELFCHECK_FIELD", field: "checked_at" });
  if (typeof report.ready !== "boolean") out.push({ code: "SELFCHECK_FIELD", field: "ready" });
  const checks: unknown = report.checks;
  if (!Array.isArray(checks) || checks.length === 0) { out.push({ code: "SELFCHECK_EMPTY", field: "checks" }); return out; }
  const seen = new Set<string>();
  let fail = false;
  for (const item of checks as unknown[]) {
    if (typeof item !== "object" || item === null) { out.push({ code: "SELFCHECK_FIELD", field: "checks" }); continue; }
    const { check, status, code } = item as Record<string, unknown>;
    const name = typeof check === "string" ? check : undefined;
    if (name === undefined || !CHECK.test(name)) out.push({ code: "SELFCHECK_CHECK_FORMAT", check: name, field: "check" });
    else if (seen.has(name)) out.push({ code: "SELFCHECK_DUPLICATE", check: name, field: "check" });
    else seen.add(name);
    if (!SELF_CHECK_STATUSES.includes(status as SelfCheckStatus)) { out.push({ code: "SELFCHECK_FIELD", check: name, field: "status" }); continue; }
    if (status === "fail") fail = true;
    if (status === "ok") {
      if (code !== undefined) out.push({ code: "SELFCHECK_CODE_FORBIDDEN", check: name, field: "code" });
    } else if (!filled(code)) {
      out.push({ code: "SELFCHECK_CODE_MISSING", check: name, field: "code" });
    } else if (!Object.hasOwn(registry, code as string)) {
      out.push({ code: "SELFCHECK_CODE_UNKNOWN", check: name, field: "code" });
    }
  }
  if (typeof report.ready === "boolean" && report.ready === fail) out.push({ code: "SELFCHECK_READY_MISMATCH", field: "ready" });
  return out;
}
