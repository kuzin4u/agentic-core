/** Сумма — целое число минимальных единиц валюты и код валюты (К9). Таблицы знаков после запятой в ядре нет:
 *  что такое единица у JPY (0 знаков), KWD (3) или USDC (6) — знает потребитель. Операции — только в одной валюте. */
export type CurrencyCode = string;

export interface Money { amount: number; currency: CurrencyCode; }

export type MoneyErrorCode = "BAD_AMOUNT" | "BAD_CURRENCY" | "CURRENCY_MISMATCH" | "BAD_WEIGHTS";

export class MoneyError extends Error {
  constructor(public code: MoneyErrorCode, msg?: string) { super(msg ?? code); }
}

/** Код ISO 4217 (`RUB`, `JPY`) или код актива потребителя (`USDC`); проверка не сводится к `[A-Z]{3}`. */
const CURRENCY = /^[A-Z][A-Z0-9]{2,11}$/;

export function isCurrencyCode(c: unknown): c is CurrencyCode {
  return typeof c === "string" && CURRENCY.test(c);
}

/** Целое число минимальных единиц: безопасное целое, ≥ 0. */
export function assertMinor(n: unknown): asserts n is number {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new MoneyError("BAD_AMOUNT");
}

export function money(amount: number, currency: CurrencyCode): Money {
  assertMinor(amount);
  if (!isCurrencyCode(currency)) throw new MoneyError("BAD_CURRENCY");
  return { amount, currency };
}

function check(m: Money): void { money(m.amount, m.currency); }

/** Сложение в одной валюте; сумма больше MAX_SAFE_INTEGER — BAD_AMOUNT, а не тихое переполнение. */
export function addMoney(a: Money, b: Money): Money {
  check(a); check(b);
  if (a.currency !== b.currency) throw new MoneyError("CURRENCY_MISMATCH");
  return money(a.amount + b.amount, a.currency);
}

/** Распределение по целым весам без потери единицы; остаток — последней доле с положительным весом.
 *  Деление через BigInt: у границы MAX_SAFE_INTEGER произведение сумма × вес не теряет точности. */
export function splitMoney(total: Money, weights: readonly number[]): Money[] {
  check(total);
  if (weights.length === 0 || !weights.every((w) => Number.isSafeInteger(w) && w >= 0)) throw new MoneyError("BAD_WEIGHTS");
  const sum = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (sum === 0n) throw new MoneyError("BAD_WEIGHTS");
  const t = BigInt(total.amount);
  const parts = weights.map((w) => (t * BigInt(w)) / sum);
  let last = weights.length - 1;
  while (weights[last] === 0) last--;
  parts[last]! += t - parts.reduce((a, b) => a + b, 0n);
  return parts.map((p) => ({ amount: Number(p), currency: total.currency }));
}
