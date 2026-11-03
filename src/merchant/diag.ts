// Реестр кодов отказов набора продавца в формате `/diag` (К17; К25 п. 8). Коды — без приставки, как в MERCHANT-API.md
// и у эмулятора продавцов платформы. `SIGNATURE_INVALID` совпадает по имени с кодом PAO_DIAG: реестры разные
// (продавца и агента), смысл один — отказ подписи агента.
import type { DiagAction, DiagEntry, DiagSource } from "../diag/index.js";
import type { MerchantPackageCode } from "./verifier.js";

export type MerchantDiagCode = MerchantPackageCode;

/** Перечень кодов для проверки полноты у потребителя: `checkDiagRegistry(MERCHANT_DIAG_CODES, MERCHANT_DIAG)`. */
export const MERCHANT_DIAG_CODES: readonly MerchantDiagCode[] = [
  "KEY_UNKNOWN", "AGENT_MISMATCH", "KEY_EXPIRED", "SIGNATURE_INVALID", "KEYS_UNAVAILABLE", "PACKAGE_INVALID", "PACKAGE_AGENT_MISMATCH",
];

const AGENT: readonly DiagSource[] = ["agent"];
const NOT_ACCEPTED = "Магазин не принял обращение агента покупателя. Оплата через агента сейчас невозможна; покупку можно оформить самостоятельно.";

function e(code: MerchantDiagCode, action: DiagAction, human: string, operator: string, norm: string, source = AGENT): DiagEntry {
  return { code, component: "core", source, action, human: { ru: human }, operator: { ru: operator }, norm, since: "0.13.0" };
}

/** По одной записи на каждый код `MerchantAuthCode` и кодов пакета. */
export const MERCHANT_DIAG: Readonly<Record<MerchantDiagCode, DiagEntry>> = {
  KEY_UNKNOWN: e("KEY_UNKNOWN", "stop", NOT_ACCEPTED,
    "Ключа с keyid подписи нет в каталоге ключей агентов и после перечитывания (или перечитывание в окне refetchMinSec уже было): ключ отозван, истёк, агент приостановлен или исключён, ключ не Ed25519 либо запись каталога не по форме (catalog().skipped).",
    "РП22 п. 1–3; MERCHANT-API §3 п. 2; К25 п. 2, 4"),
  AGENT_MISMATCH: e("AGENT_MISMATCH", "stop", NOT_ACCEPTED,
    "agent_code ключа в каталоге не равен x-agent-code обращения: подпись ключом другого агента.",
    "РП22 п. 2; MERCHANT-API §3 п. 3; К25 п. 5"),
  KEY_EXPIRED: e("KEY_EXPIRED", "stop", NOT_ACCEPTED,
    "Срок ключа агента по nbf и exp каталога не наступил или истёк; проверьте также часы сервера продавца.",
    "РП22 п. 2; MERCHANT-API §3 п. 4; К25 п. 5"),
  SIGNATURE_INVALID: e("SIGNATURE_INVALID", "stop", NOT_ACCEPTED,
    "Подпись агента неверна или неполна: нет signature, signature-input с keyid или x-agent-code при любом заголовке агента; состав компонентов, content-digest от байтов тела, x-timestamp вне окна skewSec или повтор x-nonce этого агента.",
    "РП22 п. 5; MERCHANT-API §3 п. 1, 5; К22; К25 п. 5"),
  KEYS_UNAVAILABLE: e("KEYS_UNAVAILABLE", "retry_same_key",
    "Магазин не смог проверить агента покупателя. Повторите покупку немного позже.",
    "Каталог ключей агентов не прочитан: порт AgentKeySource бросил исключение или тело не JWKS. Кэш очищен (как у платформы); следующее чтение — по неизвестному kid после окна refetchMinSec. Проверьте доступность /.well-known/agent-keys Платформы.",
    "РП22 п. 2–3; MERCHANT-API §3–4; К25 п. 4", ["platform", "environment"]),
  PACKAGE_INVALID: e("PACKAGE_INVALID", "stop", NOT_ACCEPTED,
    "Пакет агентской оплаты не разобран после верной подписи: тело не UTF-8 (BOM не снимается), не JSON или не по форме PaymentPackage (поля, вид реквизита, payload по виду, aoi).",
    "РП22 п. 5; AGENT-PROTOCOL §4; К25 п. 6"),
  PACKAGE_AGENT_MISMATCH: e("PACKAGE_AGENT_MISMATCH", "stop", NOT_ACCEPTED,
    "aoi.agent_code пакета не равен агенту, подписавшему обращение: агент передаёт реквизит другого агента.",
    "К25 п. 6 (решение владельца 03.11.2026)"),
};
