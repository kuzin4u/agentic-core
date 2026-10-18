// Реестр кодов отказов ПАО в формате `/diag` (К17 п. 5). Ручной модуль рядом с генерируемым `types.ts`:
// `action` обязан совпадать с `retry` из x-pao-errors (`PAO_ERRORS`), тест сверяет. `source` — первая оценка (документ владельца 18.10, PR #30).
import type { DiagAction, DiagEntry } from "../diag/index.js";
import type { Error as PaoErrorBody, ErrorCode } from "./types.js";

/** `retry` ПАО → действие получателя. */
export const PAO_RETRY_ACTION: Readonly<Record<PaoErrorBody["retry"], DiagAction>> = {
  never: "stop",
  same_key: "retry_same_key",
  after_fix: "after_fix",
  after_human: "after_human",
  new_key: "new_key",
};

const T6 = "AGENT-PROTOCOL §6 (РП16)";

function e(code: ErrorCode, source: DiagEntry["source"], action: DiagAction, human: string, operator: string, norm: string, since = "1.1.0"): DiagEntry {
  return { code, component: "pao", source, action, human: { ru: human }, operator: { ru: operator }, norm, since };
}

/** По одной записи на каждый код `ErrorCode` ПАО 1.4.0. */
export const PAO_DIAG: Readonly<Record<ErrorCode, DiagEntry>> = {
  AGENT_UNKNOWN: e("AGENT_UNKNOWN", ["agent"], "stop",
    "Помощник не допущен к покупкам. Обратитесь в поддержку сервиса.",
    "Агента нет в реестре Платформы: проверьте agent_code и keyid подписи, регистрацию участника.", `РП23; ${T6}`),
  AGENT_SUSPENDED: e("AGENT_SUSPENDED", ["platform"], "stop",
    "Помощник временно отключён от покупок. Обратитесь в поддержку сервиса.",
    "Агент приостановлен оператором Платформы; снятие — через оператора. GET /pao/v1/agent доступен.", `РП23; ${T6}`),
  AGENT_KEY_REVOKED: e("AGENT_KEY_REVOKED", ["agent"], "new_key",
    "Покупка не прошла по технической причине. Повторите позже.",
    "Ключ подписи агента отозван или истёк: подписать новым действующим ключом, зарегистрировать его при необходимости.", `РП23; ${T6}`),
  SIGNATURE_INVALID: e("SIGNATURE_INVALID", ["agent"], "after_fix",
    "Покупка не прошла по технической причине. Повторите позже.",
    "Подпись обращения не принята: состав полей, content-digest, окно времени, повтор nonce. Проверьте часы и подписанта.", `РП23; AGENT-PROTOCOL §2; ${T6}`),
  MANDATE_NOT_FOUND: e("MANDATE_NOT_FOUND", ["agent", "platform"], "after_human",
    "Поручение на покупку не найдено. Оформите новое поручение.",
    "Мандата нет или он принадлежит другому агенту — ответ одинаков (РП34). Проверьте mandate_id и agent_code.", `РП34; ${T6}`),
  MANDATE_EXPIRED: e("MANDATE_EXPIRED", ["client"], "after_human",
    "Срок поручения на покупку истёк. Оформите новое поручение.",
    "Мандат в статусе EXPIRED: истёк valid_to или истёк родительский INTENT (РП35).", `РП33; РП35; ${T6}`),
  MANDATE_REVOKED: e("MANDATE_REVOKED", ["client"], "stop",
    "Поручение на покупку отозвано или отклонено.",
    "Мандат в статусе REVOKED или REJECTED: отзыв клиентом, отказ банка или отзыв родительского INTENT (РП35, РП38).", `РП33; РП35; РП38; ${T6}`),
  MANDATE_SCOPE: e("MANDATE_SCOPE", ["agent"], "after_human",
    "Покупка выходит за рамки поручения: другой продавец, категория или сумма больше разрешённой.",
    "Корзина вне предмета мандата: продавец, категория или сумма. Сверьте корзину с мандатом до запроса.", `A7 п. 5.2; ${T6}`),
  PRINCIPAL_SIGNATURE_PENDING: e("PRINCIPAL_SIGNATURE_PENDING", ["client"], "after_human",
    "Поручение ещё не подписано. Подпишите его в приложении банка.",
    "Мандат в статусе PENDING_SIGNATURE: клиент не подписал. Ждать события подписи, не повторять запрос в цикле.", `РП33; ${T6}`),
  LIMIT_EXCEEDED: e("LIMIT_EXCEEDED", ["bank"], "after_human",
    "Покупка превышает ограничение вашей карты или счёта. Измените ограничение в банке или уменьшите сумму.",
    "Отказ по ограничению платёжного инструмента у банка.", T6),
  STATE_UNAVAILABLE: e("STATE_UNAVAILABLE", ["platform"], "retry_same_key",
    "Не удалось подтвердить состояние покупки. Повторяем автоматически.",
    "Состояние не подтверждено (цепочка журнала, гонка): повтор с тем же Idempotency-Key по Retry-After.", `инвариант 3 Платформы; ${T6}`),
  CONFIRMATION_REQUIRED: e("CONFIRMATION_REQUIRED", ["client"], "after_human",
    "Нужно ваше подтверждение покупки.",
    "Платформа требует подтверждения клиента до исполнения; повтор — после подтверждения.", T6),
  CREDENTIAL_INVALID: e("CREDENTIAL_INVALID", ["agent"], "after_fix",
    "Покупка не прошла по технической причине. Повторите позже.",
    "Платёжный реквизит уже использован, истёк или выпущен не для этого продавца: запросить новый.", T6),
  CREDENTIALS_FORBIDDEN: e("CREDENTIALS_FORBIDDEN", ["agent"], "stop",
    "Покупка не прошла по технической причине. Обратитесь в поддержку сервиса.",
    "В запросе есть платёжные реквизиты — агенту запрещено их передавать. Дефект агента, запрос не повторять.", T6),
  IDEMPOTENCY_REQUIRED: e("IDEMPOTENCY_REQUIRED", ["agent"], "retry_same_key",
    "Покупка не прошла по технической причине. Повторите позже.",
    "Нет заголовка Idempotency-Key у изменяющего запроса: добавить ключ и повторить.", `РП30; ${T6}`),
  IDEMPOTENCY_CONFLICT: e("IDEMPOTENCY_CONFLICT", ["agent"], "after_fix",
    "Покупка не прошла по технической причине. Повторите позже.",
    "Тот же Idempotency-Key с другим телом: дефект агента или повтор с изменённым запросом; новый запрос — с новым ключом.", `РП33; ${T6}`),
  RATE_LIMITED: e("RATE_LIMITED", ["agent"], "retry_same_key",
    "Слишком много запросов. Повторяем автоматически чуть позже.",
    "Превышена частота обращений агента: повтор с тем же ключом по Retry-After.", T6),
  UPSTREAM_UNAVAILABLE: e("UPSTREAM_UNAVAILABLE", ["environment"], "retry_same_key",
    "Сервис временно недоступен. Повторяем автоматически.",
    "Компонент Платформы недоступен (хранилище, банк): повтор с тем же ключом по Retry-After.", `РП24; ${T6}`),
  REQUEST_INVALID: e("REQUEST_INVALID", ["agent"], "after_fix",
    "Покупка не прошла по технической причине. Обратитесь в поддержку сервиса.",
    "Тело или параметры не по схеме метода, реквизит недопустим: дефект агента, сверить с agent-protocol.yaml.", `РП31; РП33; ${T6}`, "1.3.0"),
  KEY_INVALID: e("KEY_INVALID", ["agent"], "after_fix",
    "Не удалось подключить помощника. Обратитесь в поддержку сервиса.",
    "Регистрируемый ключ агента не принят (формат, слабый ключ): выпустить другой ключ.", `РП31; К11; ${T6}`, "1.3.0"),
};
