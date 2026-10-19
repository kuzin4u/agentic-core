// Каталог испытаний ядра (К19 п. 6): ситуации для пунктов с repo agentic-core и «вне испытаний» для процессных.
// Стенд — настоящий код ядра; отклонённый вариант эмулируется поверх него: так, как работало бы ядро при другом решении.
import { checkDiagRegistry, buildSelfCheckReport, checkSelfCheckReport, diagAction, type DiagEntry, type SelfCheckReport } from "../../src/diag/index.js";
import { CATALOG_DIAG, checkLiveOffer, checkProductA5, type CatalogProduct, type LiveOffer } from "../../src/catalog/index.js";
import { newEd25519Signer } from "../../src/index.js";
import { PAO_CLIENT_DIAG, PAO_DIAG, PaoCallError, PaoClient } from "../../src/pao/index.js";
import { TRIAL_UNSUPPORTED, type TrialExclusion, type TrialOutcome, type TrialSituation, type TrialStand } from "../../src/trials/index.js";

const UNSIGNED = "GET /.well-known/pao-configuration";
const SIGNED = "GET /pao/v1/agent";

export const CORE_SITUATIONS: readonly TrialSituation[] = [
  {
    id: "РЗ-1.тексты-diag", refs: ["РЗ-1"],
    params: { human: ["Текст человеку.", "", "  "], lang: ["ru", "en"] },
    expect: [{ when: { human: ["Текст человеку."], lang: ["ru"] }, outcome: { problems: [] } }, { outcome: { problems: ["DIAG_EMPTY"] } }],
    rejected: [{ variant: "пустые-тексты", note: "Р-1: пустые тексты в ядре — один текст в двух местах" }],
  },
  {
    id: "РЗ-3.отчёт-самопроверки", refs: ["РЗ-3"],
    params: { defect: ["нет", "component", "повтор-check"] },
    expect: [
      { when: { defect: ["нет"] }, outcome: { problems: [] } },
      { when: { defect: ["component"] }, outcome: { problems: ["SELFCHECK_FIELD"] } },
      { outcome: { problems: ["SELFCHECK_DUPLICATE"] } },
    ],
    rejected: [{ variant: "без-двух-кодов", note: "Р-3: без SELFCHECK_FIELD и SELFCHECK_DUPLICATE — отчёт извне прошёл бы с неверными полями" }],
  },
  {
    // Пересмотр Р-4 — v0.11.0 (строгий разбор дат): тогда ожидаемый исход и отклонённый вариант поменяются местами через /decision.
    id: "РЗ-4.checked_at", refs: ["РЗ-4"],
    params: {
      at: ["2026-10-19T10:00:00.000Z", "2024-02-29T10:00:00Z", "2026-02-30T10:00:00.000Z", "2026-02-29T10:00:00Z", "2026-10-19T24:00:00Z",
        "2026-12-31T23:59:60Z", "2026-13-01T00:00:00Z", "2026-10-19T10:00:00+03:00"],
    },
    expect: [
      { when: { at: ["2026-10-19T10:00:00.000Z", "2024-02-29T10:00:00Z"] }, outcome: { problems: [] } },
      { outcome: { problems: ["SELFCHECK_FIELD"] } },
    ],
    rejected: [{ variant: "только-формат", note: "Р-4 до К20: шаблон и Date.parse — 30 февраля и T24:00 принимаются" }],
  },
  {
    id: "РЗ-5.действия-LIVE", refs: ["РЗ-5"],
    params: { code: ["LIVE_UNAVAILABLE", "LIVE_STALE", "LIVE_QUANTITY", "LIVE_PRICE_UP", "LIVE_PRICE_DOWN", "LIVE_INVALID", "LIVE_CURRENCY", "LIVE_OUT_OF_STOCK"] },
    expect: [
      { when: { code: ["LIVE_UNAVAILABLE", "LIVE_STALE"] }, outcome: { action: "retry_same_key" } },
      { when: { code: ["LIVE_QUANTITY", "LIVE_PRICE_UP", "LIVE_PRICE_DOWN"] }, outcome: { action: "after_human" } },
      { outcome: { action: "stop" } },
    ],
    rejected: [{ variant: "всё-стоп", note: "Р-5: стартовая таблица — всё «стоп»" }],
  },
  {
    id: "РЗ-6.действия-ПАО", refs: ["РЗ-6"],
    params: { code: ["SIGNATURE_INVALID", "IDEMPOTENCY_CONFLICT", "KEY_INVALID", "AGENT_SUSPENDED", "MANDATE_EXPIRED", "IDEMPOTENCY_REQUIRED"] },
    expect: [
      { when: { code: ["SIGNATURE_INVALID", "IDEMPOTENCY_CONFLICT", "KEY_INVALID"] }, outcome: { action: "after_fix" } },
      { when: { code: ["AGENT_SUSPENDED"] }, outcome: { action: "stop" } },
      { when: { code: ["MANDATE_EXPIRED"] }, outcome: { action: "after_human" } },
      { outcome: { action: "retry_same_key" } },
    ],
    rejected: [{ variant: "таблица-документа", note: "Р-6: стартовая таблица документа о диагностике (расхождение № 22)", must: "all" }],
  },
  {
    id: "РЗ-7.перенаправления", refs: ["РЗ-7", "РЗ-57"],
    params: { status: [301, 302, 303, 307, 308], op: [UNSIGNED, SIGNED] },
    expect: [{ outcome: { result: "refuse", clientCode: "PAO_CLIENT_REDIRECT", code: null, followed: false } }],
    rejected: [
      { variant: "только-подписанные", note: "Р-7: запрет только для подписанных запросов" },
      { variant: "код-в-code", note: "Р-57: расширить тип code — сломал бы switch потребителей", must: "all" },
    ],
  },
  {
    id: "РЗ-56.реестр-кодов-клиента", refs: ["РЗ-56"],
    params: { code: ["PAO_CLIENT_REDIRECT", "PAO_CLIENT_SIGNER_MISSING"] },
    expect: [{ outcome: { registry: "PAO_CLIENT_DIAG", component: "core", paoDiagSize: 20 } }],
    rejected: [{ variant: "в-PAO_DIAG", note: "Р-56: в PAO_DIAG — там ровно 20 кодов спецификации", must: "all" }],
  },
  {
    id: "РЗ-58.действие-перенаправления", refs: ["РЗ-58"],
    params: {},
    expect: [{ outcome: { action: "after_fix" } }],
    rejected: [{ variant: "стоп", note: "Р-58: stop — остановил бы агента там, где хватает правки адреса" }],
  },
  {
    id: "РЗ-60.без-подписанта", refs: ["РЗ-60"],
    params: { op: [SIGNED, "POST /pao/v1/mandates"] },
    expect: [{ outcome: { constructed: true, clientCode: "PAO_CLIENT_SIGNER_MISSING", fetchCalls: 0 } }],
    rejected: [{ variant: "ошибка-в-конструкторе", note: "Р-60: ошибка в конструкторе клиента", must: "all" }],
  },
  {
    id: "КП-7.равенство-сведений", refs: ["КП-7"],
    params: { text: ["", "Цена 250 ₽", "Цена 300 ₽", "Было 300 ₽, стало 250 ₽"] },
    expect: [
      { when: { text: ["", "Цена 250 ₽"] }, outcome: { signals: [] } },
      { outcome: { signals: ["A5_PRICE_MISMATCH"] } },
    ],
    rejected: [{ variant: "саморегулирование", note: "КП-7: саморегулирование площадок — равенство раскрытия не проверяется" }],
  },
  {
    id: "КП-8.цена-после-согласования", refs: ["КП-8"],
    params: { delta: [-500, -1, 0, 1, 500] },
    expect: [
      { when: { delta: [0] }, outcome: { ok: true } },
      { when: { delta: [1, 500] }, outcome: { ok: false, codes: ["LIVE_PRICE_UP"] } },
      { outcome: { ok: false, codes: ["LIVE_PRICE_DOWN"] } },
    ],
    rejected: [{ variant: "коридор-1%", note: "КП-8: допуск изменения в пределах коридора клиента (здесь 1 % цены)" }],
  },
];

const fork = (ref: string, reason: string, recordedIn: string): TrialExclusion => ({ ref, basis: "process", reason, recordedIn });

/** Процессные развилки без поведения кода (решение владельца п. 5): порядок работы, выпуски, правила репозиториев. */
export const CORE_EXCLUSIONS: readonly TrialExclusion[] = [
  fork("РЗ-2", "срок выпуска v0.8.0 — порядок работ, не поведение кода", "К17, PR #30"),
  fork("РЗ-32", "передачи между репозиториями — задачами GitHub с меткой «передача»", "мера 1"),
  fork("РЗ-33", "слияние PR по команде чата — процесс владельца", "мера 2"),
  fork("РЗ-34", "коммит после отдельной проверки, add и commit через && — правило CLAUDE.md", "CLAUDE.md"),
  fork("РЗ-35", "одна копия ядра при разных версиях у стенда и агента — сведение зависимостей npm у потребителя", "Р34"),
  fork("РЗ-36", "адреса git+https в lock — проверяет тест потребителя, не ядро", "К1.8, К1.2"),
  fork("РЗ-59", "номер выпуска v0.9.0 — правило версий, не поведение кода", "К18"),
  fork("РЗ-74", "сама схема испытаний; её механизм проверяют тесты /trials", "«Матрица испытаний и эмулятор ситуаций», К19"),
];

// --- стенд ---

const diagEntry = (human: Record<string, string>): DiagEntry => ({
  code: "X_ONE", component: "core", source: ["merchant"], action: "stop", human: human as DiagEntry["human"],
  operator: { ru: "Текст оператору." }, norm: "К17", since: "0.8.0",
});

function selfCheck(report: SelfCheckReport, variant: string): TrialOutcome {
  let problems: string[] = checkSelfCheckReport(report, CATALOG_DIAG).map((p) => p.code);
  if (variant === "без-двух-кодов") problems = problems.filter((c) => c !== "SELFCHECK_FIELD" && c !== "SELFCHECK_DUPLICATE");
  return { problems };
}

/** «Только формат» — как ядро работало до К20 (отклонённый вариант Р-4): шаблон UTC и Date.parse не NaN. */
function formatOnlyOk(at: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(at) && !Number.isNaN(Date.parse(at));
}

const DOCUMENT_TABLE: Record<string, string> = {
  SIGNATURE_INVALID: "stop", IDEMPOTENCY_CONFLICT: "stop", KEY_INVALID: "new_key",
  AGENT_SUSPENDED: "after_human", MANDATE_EXPIRED: "stop", IDEMPOTENCY_REQUIRED: "after_fix",
};

const product: CatalogProduct = {
  sku: "tartine", gtin: null, brand: null, model: null, attributes: {}, title: "Тартин", category: "Хлеб",
  price: { amount: 25000, currency: "RUB" }, availability: { inStock: true, quantity: 10 },
  delivery: [{ method: "PICKUP", minDays: 0, maxDays: 0, cost: { amount: 0, currency: "RUB" } }], updatedAt: "2026-10-17T07:00+03:00",
};

async function redirect(status: number, op: string, variant: string): Promise<TrialOutcome> {
  if (variant === "только-подписанные" && op === UNSIGNED) return { result: "ok", clientCode: null, code: null, followed: true };
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; return new Response(null, { status, headers: { location: "http://other.example/x" } }); };
  const client = new PaoClient({ baseUrl: "http://pao.example", agentCode: "AG-1", signer: newEd25519Signer("k-t").signer, fetch, sleep: async () => {} });
  try {
    await client.call(op as typeof UNSIGNED, {});
    return { result: "ok", followed: calls > 1 };
  } catch (e) {
    if (!(e instanceof PaoCallError)) throw e;
    const code = variant === "код-в-code" ? (e.clientCode ?? null) : (e.code ?? null);
    return { result: "refuse", clientCode: e.clientCode ?? null, code, followed: calls > 1 };
  }
}

async function noSigner(op: string, variant: string): Promise<TrialOutcome> {
  if (variant === "ошибка-в-конструкторе") return { constructed: false };
  let fetchCalls = 0;
  const client = new PaoClient({ baseUrl: "http://pao.example", agentCode: "AG-1", fetch: async () => { fetchCalls++; return new Response("{}"); } });
  try {
    await (client as unknown as { call(op: string, args: object): Promise<unknown> }).call(op, { body: {} });
    return { constructed: true, clientCode: null, fetchCalls };
  } catch (e) {
    return { constructed: true, clientCode: e instanceof PaoCallError ? (e.clientCode ?? null) : "other", fetchCalls };
  }
}

export const coreStand: TrialStand = {
  async run({ situation, params, variant }) {
    switch (situation) {
      case "РЗ-1.тексты-diag": {
        if (variant !== "chosen" && variant !== "пустые-тексты") return TRIAL_UNSUPPORTED;
        const problems = checkDiagRegistry(["X_ONE"], { X_ONE: diagEntry({ [params.lang as string]: params.human as string }) }).map((p) => p.code);
        return { problems: variant === "пустые-тексты" ? problems.filter((c) => c !== "DIAG_EMPTY") : problems };
      }
      case "РЗ-3.отчёт-самопроверки": {
        if (variant !== "chosen" && variant !== "без-двух-кодов") return TRIAL_UNSUPPORTED;
        const base = buildSelfCheckReport("core", "0.10.0", [{ check: "db.migrations", status: "ok" }, { check: "feed.yml", status: "warn", code: "LIVE_STALE" }], new Date(0));
        const report = params.defect === "component" ? { ...base, component: "bank" as never }
          : params.defect === "повтор-check" ? { ...base, checks: [...base.checks, { check: "db.migrations", status: "ok" as const }] } : base;
        return selfCheck(report, variant);
      }
      case "РЗ-4.checked_at": {
        if (variant !== "chosen" && variant !== "только-формат") return TRIAL_UNSUPPORTED;
        const report = { ...buildSelfCheckReport("core", "0.11.0", [{ check: "db.migrations", status: "ok" }]), checked_at: params.at as string };
        if (variant === "только-формат" && formatOnlyOk(params.at as string)) return { problems: [] };
        return selfCheck(report, "chosen");
      }
      case "РЗ-5.действия-LIVE":
        if (variant === "всё-стоп") return { action: "stop" };
        return variant === "chosen" ? { action: diagAction(CATALOG_DIAG, params.code as string) } : TRIAL_UNSUPPORTED;
      case "РЗ-6.действия-ПАО":
        if (variant === "таблица-документа") return { action: DOCUMENT_TABLE[params.code as string] as string };
        return variant === "chosen" ? { action: diagAction(PAO_DIAG, params.code as string) } : TRIAL_UNSUPPORTED;
      case "РЗ-7.перенаправления":
        if (!["chosen", "только-подписанные", "код-в-code"].includes(variant)) return TRIAL_UNSUPPORTED;
        return redirect(params.status as number, params.op as string, variant);
      case "РЗ-56.реестр-кодов-клиента": {
        if (variant === "в-PAO_DIAG") return { registry: "PAO_DIAG", component: "pao", paoDiagSize: 22 };
        if (variant !== "chosen") return TRIAL_UNSUPPORTED;
        const code = params.code as string;
        const registry = Object.hasOwn(PAO_DIAG, code) ? "PAO_DIAG" : Object.hasOwn(PAO_CLIENT_DIAG, code) ? "PAO_CLIENT_DIAG" : null;
        const entry = (PAO_CLIENT_DIAG as Record<string, DiagEntry>)[code];
        return { registry, component: entry?.component ?? null, paoDiagSize: Object.keys(PAO_DIAG).length };
      }
      case "РЗ-58.действие-перенаправления":
        if (variant === "стоп") return { action: "stop" };
        return variant === "chosen" ? { action: diagAction(PAO_CLIENT_DIAG, "PAO_CLIENT_REDIRECT") } : TRIAL_UNSUPPORTED;
      case "РЗ-60.без-подписанта":
        if (variant !== "chosen" && variant !== "ошибка-в-конструкторе") return TRIAL_UNSUPPORTED;
        return noSigner(params.op as string, variant);
      case "КП-7.равенство-сведений": {
        if (variant === "саморегулирование") return { signals: [] };
        if (variant !== "chosen") return TRIAL_UNSUPPORTED;
        return { signals: checkProductA5({ ...product, description: params.text as string }, 2).map((s) => s.code) };
      }
      case "КП-8.цена-после-согласования": {
        if (variant !== "chosen" && variant !== "коридор-1%") return TRIAL_UNSUPPORTED;
        const delta = params.delta as number;
        const now = Date.parse("2026-10-17T12:00:00+03:00");
        const offer: LiveOffer = { sku: "tartine", price: { amount: 25000 + delta, currency: "RUB" }, availability: { inStock: true, quantity: 5 }, checkedAt: "2026-10-17T11:59:50+03:00" };
        const r = await checkLiveOffer(product, { sku: "tartine", quantity: 2 }, { fetch: async () => offer }, { now: () => now });
        if (variant === "коридор-1%" && !r.ok && r.codes.every((c) => c === "LIVE_PRICE_UP" || c === "LIVE_PRICE_DOWN") && Math.abs(delta) * 100 <= product.price.amount) return { ok: true };
        return r.ok ? { ok: true } : { ok: false, codes: r.codes };
      }
      default:
        return TRIAL_UNSUPPORTED;
    }
  },
};
