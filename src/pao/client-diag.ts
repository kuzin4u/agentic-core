// Реестр кодов отказов клиента ПАО в формате `/diag` (К18 п. 2). Коды выдаёт ядро, а не Платформа по ПАО,
// поэтому они не в `PAO_DIAG`: там ровно коды `ErrorCode` спецификации.
import type { DiagEntry } from "../diag/index.js";

export type PaoClientCode = "PAO_CLIENT_REDIRECT" | "PAO_CLIENT_SIGNER_MISSING";

/** Перечень кодов для проверки полноты: `checkDiagRegistry(PAO_CLIENT_CODES, PAO_CLIENT_DIAG)`. */
export const PAO_CLIENT_CODES: readonly PaoClientCode[] = ["PAO_CLIENT_REDIRECT", "PAO_CLIENT_SIGNER_MISSING"];

const TECH = "Покупка не прошла по технической причине. Обратитесь в поддержку сервиса.";

export const PAO_CLIENT_DIAG: Readonly<Record<PaoClientCode, DiagEntry>> = {
  PAO_CLIENT_REDIRECT: {
    code: "PAO_CLIENT_REDIRECT", component: "core", source: ["agent", "platform", "environment"], action: "after_fix",
    human: { ru: TECH },
    operator: { ru: "Платформа или посредник ответили перенаправлением 3xx; клиент ПАО ему не следует, запрос на другой адрес не уходил. Проверьте адрес Платформы (схема https, хост, путь); если адрес верный — возможна подмена ответа, оформите инцидент." },
    norm: "К18; #32", since: "0.9.0",
  },
  PAO_CLIENT_SIGNER_MISSING: {
    code: "PAO_CLIENT_SIGNER_MISSING", component: "core", source: ["agent"], action: "after_fix",
    human: { ru: TECH },
    operator: { ru: "Подписанная операция ПАО вызвана у клиента без подписанта: передайте signer в PaoClient. Запрос в сеть не уходил." },
    norm: "К18; #32", since: "0.9.0",
  },
};
