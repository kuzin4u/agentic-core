// Реестр кодов отказов `/catalog` в формате `/diag` (К17 п. 1). Все коды появились в v0.6.0 (К8, К14, К15).
// `source` — первая оценка документа владельца (`merchant`); у `LIVE_UNAVAILABLE` — ещё `environment` (сеть, тайм-аут).
import type { DiagAction, DiagEntry, DiagSource } from "../diag/index.js";
import type { A5SignalCode } from "./a5.js";
import type { LiveCheckCode } from "./live.js";
import type { CatalogIssueCode } from "./validate.js";

export type CatalogDiagCode = CatalogIssueCode | A5SignalCode | LiveCheckCode;

/** Перечни кодов для проверки полноты у потребителя: `checkDiagRegistry(CATALOG_DIAG_CODES, CATALOG_DIAG)`. */
export const CATALOG_ISSUE_CODES: readonly CatalogIssueCode[] = [
  "REQUIRED", "BAD_TYPE", "BAD_AMOUNT", "BAD_CURRENCY", "BAD_INN", "BAD_MCC", "BAD_GTIN", "BAD_DATE", "BAD_RANGE",
  "BAD_METHOD", "UNKNOWN_REGION",
  "XML_SYNTAX", "XML_ENTITY", "XML_DOCTYPE", "XML_ENCODING", "XML_LIMIT",
  "YML_STRUCTURE", "YML_DATE", "YML_CURRENCY", "YML_PRICE", "YML_CATEGORY", "YML_NUMBER",
];
export const A5_SIGNAL_CODES: readonly A5SignalCode[] = ["A5_PRICE_MISMATCH", "A5_RETURNS_MISMATCH"];
export const LIVE_CHECK_CODES: readonly LiveCheckCode[] = [
  "LIVE_UNAVAILABLE", "LIVE_INVALID", "LIVE_STALE", "LIVE_CURRENCY", "LIVE_PRICE_UP", "LIVE_PRICE_DOWN",
  "LIVE_OUT_OF_STOCK", "LIVE_QUANTITY",
];
export const CATALOG_DIAG_CODES: readonly CatalogDiagCode[] = [...CATALOG_ISSUE_CODES, ...A5_SIGNAL_CODES, ...LIVE_CHECK_CODES];

const M: readonly DiagSource[] = ["merchant"];
const FEED = "Товар из каталога магазина сейчас недоступен для покупки. Выберите другой товар или магазин.";

function e(code: CatalogDiagCode, action: DiagAction, human: string, operator: string, norm: string, source = M): DiagEntry {
  return { code, component: "core", source, action, human: { ru: human }, operator: { ru: operator }, norm, since: "0.6.0" };
}

const model = (code: CatalogIssueCode, operator: string, norm = "К8 п. 1") => e(code, "after_fix", FEED, operator, norm);
const xml = (code: CatalogIssueCode, operator: string) => e(code, "after_fix", FEED, `Фид не разобран: ${operator} Путь — @смещение во входе.`, "К14 п. 5");
const yml = (code: CatalogIssueCode, operator: string, norm = "К14 п. 1") => e(code, "after_fix", FEED, operator, norm);

/** По одной записи на каждый код `CatalogIssueCode`, `A5SignalCode`, `LiveCheckCode`. */
export const CATALOG_DIAG: Readonly<Record<CatalogDiagCode, DiagEntry>> = {
  REQUIRED: model("REQUIRED", "В данных продавца нет обязательного поля; путь — в замечании."),
  BAD_TYPE: model("BAD_TYPE", "Поле не того типа или пустая строка; путь — в замечании."),
  BAD_AMOUNT: model("BAD_AMOUNT", "Сумма не целое число минимальных единиц ≥ 0 в пределах Number.isSafeInteger.", "К8 п. 1; К9"),
  BAD_CURRENCY: model("BAD_CURRENCY", "Код валюты не ISO 4217 и не код актива.", "К8 п. 1; К9"),
  BAD_INN: model("BAD_INN", "ИНН продавца не 10 или 12 цифр либо неверная контрольная цифра."),
  BAD_MCC: model("BAD_MCC", "MCC продавца не из 4 цифр."),
  BAD_GTIN: model("BAD_GTIN", "GTIN не 8, 12, 13 или 14 цифр либо неверная контрольная цифра."),
  BAD_DATE: model("BAD_DATE", "Дата не ISO 8601 с часовым поясом."),
  BAD_RANGE: model("BAD_RANGE", "Число вне допустимого: отрицательное, дробное, minDays > maxDays, рейтинг вне 0…1, самовывоз не за 0."),
  BAD_METHOD: model("BAD_METHOD", "Способ получения не DELIVERY и не PICKUP."),
  UNKNOWN_REGION: model("UNKNOWN_REGION", "Регион доставки товара не входит в регионы доставки магазина."),
  XML_SYNTAX: xml("XML_SYNTAX", "вход не XML или вне подмножества, символ вне XML 1.0."),
  XML_ENTITY: xml("XML_ENTITY", "сущность не из пяти предопределённых и не допустимая числовая."),
  XML_DOCTYPE: xml("XML_DOCTYPE", "DOCTYPE с внутренним подмножеством, иной формы, длиннее 1 КиБ, повторный или после корня; DTD не исполняется."),
  XML_ENCODING: xml("XML_ENCODING", "кодировка не UTF-8 и не windows-1251 либо неверная последовательность байт."),
  XML_LIMIT: xml("XML_LIMIT", "больше maxBytes, глубже maxDepth или больше 256 атрибутов у элемента."),
  YML_STRUCTURE: yml("YML_STRUCTURE", "Корень фида не yml_catalog или нет shop, offers."),
  YML_DATE: yml("YML_DATE", "yml_catalog@date не дата или без часового пояса и без offset."),
  YML_CURRENCY: yml("YML_CURRENCY", "У предложения нет currencyId или его нет среди currencies."),
  YML_PRICE: yml("YML_PRICE", "Цена или стоимость доставки не число, знаков больше exponent или больше Number.MAX_SAFE_INTEGER.", "К14 п. 3; К9"),
  YML_CATEGORY: yml("YML_CATEGORY", "Нет categoryId, нет такой категории, разрыв или цикл parentId."),
  YML_NUMBER: yml("YML_NUMBER", "count или days варианта доставки не целое ≥ 0."),
  A5_PRICE_MISMATCH: e("A5_PRICE_MISMATCH", "after_fix",
    "Цена в описании товара не совпадает с ценой в каталоге. Товар не предлагается, пока магазин не исправит описание.",
    "Правило A5: в названии или описании цена не та, что в price; found — сумма из текста (null — не выражается в единицах валюты).", "К8 п. 1"),
  A5_RETURNS_MISMATCH: e("A5_RETURNS_MISMATCH", "after_fix",
    "Условия возврата в описании магазина противоречат друг другу. Уточните условия у магазина.",
    "Правило A5: срок в тексте возврата не тот, что в returns.days, или «возврата нет» при days > 0; found — срок из текста.", "К8 п. 1"),
  LIVE_UNAVAILABLE: e("LIVE_UNAVAILABLE", "retry_same_key",
    "Не удалось уточнить цену и наличие у магазина. Повторите позже.",
    "Источник живого предложения бросил, отклонил или не ответил за timeoutMs; либо неожиданное исключение проверки. Повтор — решение потребителя.",
    "К15 п. 3, п. 5", ["merchant", "environment"]),
  LIVE_INVALID: e("LIVE_INVALID", "after_fix",
    "Магазин сообщил неполные данные о товаре. Выберите другой товар или повторите позже.",
    "Ответ продавца не по форме: не тот sku, сумма не по К9, наличие не по модели, checkedAt без часового пояса.", "К15 п. 3"),
  LIVE_STALE: e("LIVE_STALE", "retry_same_key",
    "Не удалось получить свежие данные о цене у магазина. Повторите позже.",
    "checkedAt ответа старше maxAgeMs или в будущем больше чем на clockSkewMs: проверьте часы продавца и кэш его API.", "К15 п. 3"),
  LIVE_CURRENCY: e("LIVE_CURRENCY", "after_fix",
    "Магазин указал цену в другой валюте. Товар сейчас недоступен для покупки.",
    "Валюта живого предложения не та, что в каталоге; курсов в ядре нет.", "К15 п. 3"),
  LIVE_PRICE_UP: e("LIVE_PRICE_UP", "after_human",
    "Цена товара выросла. Подтвердите покупку по новой цене.",
    "Цена у продавца выше каталожной (допуска нет, К15 п. 4): обновить позицию из offer и спросить покупателя.", "К15 п. 3, п. 4"),
  LIVE_PRICE_DOWN: e("LIVE_PRICE_DOWN", "after_human",
    "Цена товара изменилась. Подтвердите покупку по новой цене.",
    "Цена у продавца ниже каталожной (допуска нет, К15 п. 4): каталог устарел; обновить позицию из offer и спросить покупателя.", "К15 п. 3, п. 4"),
  LIVE_OUT_OF_STOCK: e("LIVE_OUT_OF_STOCK", "stop",
    "Товара нет в наличии. Выберите другой товар.",
    "availability.inStock ложно в живом предложении.", "К15 п. 3"),
  LIVE_QUANTITY: e("LIVE_QUANTITY", "after_human",
    "В наличии меньше товара, чем вы выбрали. Уменьшите количество.",
    "Продавец сообщил quantity меньше запрошенного.", "К15 п. 3"),
};
