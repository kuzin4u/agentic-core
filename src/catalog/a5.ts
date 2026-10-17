import type { CatalogProduct, CatalogShop } from "./types.js";

/** Правило A5 (К8 п. 1): цена и условия в полях совпадают с текстом и для агента те же, что для человека.
 *  Расхождение — признак нарушения у продавца, а не ошибка разбора: отдельные коды, данные — уже прошедшие `validate*`.
 *  `found` — что сказано в тексте: сумма в минимальных единицах или срок возврата в днях;
 *  `null` — сумма в тексте не выражается в единицах валюты (знаков после запятой больше `exponent`). */
export interface A5Signal { code: A5SignalCode; path: string; found: number | null; }

export type A5SignalCode =
  | "A5_PRICE_MISMATCH"    // в названии или описании цена не та, что в `price`
  | "A5_RETURNS_MISMATCH"; // в тексте возврата срок не тот, что в `returns.days`, или «возврата нет» при `days` > 0

/** Цена в тексте против `price`. `exponent` — знаков после запятой у валюты цены (RUB — 2): таблицы в ядре нет (К9).
 *  Упоминание цены — число перед кодом валюты цены, для RUB ещё перед `₽`, `руб`, `р.`; код валюты — и перед числом
 *  («RUB 250»). «2 250 ₽» и «250,50 руб.» понимаются; «500 250 ₽» читается как 500 250 — разряды через пробел.
 *  Каждое упоминание, отличное от `price`, — сигнал («было 300 ₽, стало 250 ₽» даёт сигнал на 300). */
export function checkProductA5(p: CatalogProduct, exponent: number): A5Signal[] {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 18) throw new RangeError("exponent");
  const out: A5Signal[] = [];
  for (const k of ["title", "description"] as const) {
    const text = p[k];
    if (text === undefined) continue;
    for (const found of pricesIn(text, p.price.currency, exponent)) {
      if (found !== p.price.amount) out.push({ code: "A5_PRICE_MISMATCH", path: `$.${k}`, found });
    }
  }
  return out;
}

/** Текст возврата против `returns.days`. Понимаются сроки цифрами («14 дней», «7 календарных дней», «3 суток») и отказ
 *  от возврата («не подлежат возврату», «без возврата»). Срок словами («две недели») не распознаётся — сигнала нет. */
export function checkShopA5(s: CatalogShop): A5Signal[] {
  const { days, text } = s.returns;
  const terms = [...text.matchAll(DAYS)].map((m) => Number(m[1]));
  const none = NO_RETURN.test(text);
  const at = "$.returns.text";
  if (days === 0) {
    // «Не подлежат возврату, обмен — 14 дней»: срок относится не к возврату, сигнала нет.
    const t = none ? undefined : terms.find((n) => n > 0);
    return t === undefined ? [] : [{ code: "A5_RETURNS_MISMATCH", path: at, found: t }];
  }
  const t = terms.find((n) => n !== days);
  if (t !== undefined) return [{ code: "A5_RETURNS_MISMATCH", path: at, found: t }];
  return none && terms.length === 0 ? [{ code: "A5_RETURNS_MISMATCH", path: at, found: 0 }] : [];
}

// Выражения линейны на любом тексте продавца (CodeQL js/polynomial-redos): совпадение начинается только с начала числа
// или слова — просмотром назад, иначе повтор с каждой позиции даёт квадратичное время на «999…», «1 111 111…», «возвратвозврат…».
// Число (не продолжение другого числа и его разрядов): целое с разрядами через пробел (обычный, неразрывный, узкий) или без, дробная часть через точку или запятую.
const NUM = String.raw`(?<![\d.,]|\d[ \u00A0\u202F])(\d{1,3}(?:[ \u00A0\u202F]\d{3})+|\d+)(?:[.,](\d+))?`;
const RUB = String.raw`₽|руб(?:\.|л[а-яё]*)?|р\.`;
const DAYS = /(?<!\d)(\d+)\s*(?:(?:календарн|рабоч)[а-яё]*\s+)?(?:дн(?:я|ей)|день|сут(?:ок|ки))/giu;
const NO_RETURN = /(?<![а-яё])(?:не\s+подлеж|без\s+возврат|возврат[а-яё]*\s+не\s+(?:принима|осуществля|производ|предусм)|не\s+возвраща)/iu;

function pricesIn(text: string, currency: string, exponent: number): (number | null)[] {
  const code = escape(currency);
  const mark = currency === "RUB" ? `${RUB}|${code}` : code;
  // Граница слова для кириллицы — вручную: после знака валюты не буква («рубашка» — не рубли).
  const after = new RegExp(String.raw`${NUM}\s*(?:${mark})(?![a-zа-яё])`, "giu");
  // Перед числом — только код валюты: «250 ₽ 300 г» не должно дать цену 300.
  const before = new RegExp(String.raw`(?<![A-Za-z])${code}\s*${NUM}`, "gu");
  const out: (number | null)[] = [];
  for (const re of [after, before]) for (const m of text.matchAll(re)) out.push(minor(m[1]!, m[2], exponent));
  return out;
}

/** Сумма из текста в минимальных единицах; `null` — не выражается (дробных знаков больше, чем у валюты, или больше MAX_SAFE_INTEGER). */
function minor(int: string, frac: string | undefined, exponent: number): number | null {
  const f = frac ?? "";
  if (f.length > exponent) return null;
  const v = BigInt(int.replace(/[ \u00A0\u202F]/g, "")) * 10n ** BigInt(exponent) + BigInt(f.padEnd(exponent, "0") || "0");
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
}

function escape(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
