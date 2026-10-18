/** Формат реестра кодов отказов (К17, CO-ДГ): запись, проверка полноты, действие по коду; основной вход пакета их не реэкспортирует. */

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
