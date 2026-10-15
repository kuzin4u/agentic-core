import { isCurrencyCode, type Money } from "./money.js";
import { HoldError } from "./holds.js";

/** Сумма из Money для holds: безопасное целое ≥ min, иначе BAD_AMOUNT; код валюты — как в money, иначе BAD_CURRENCY.
 *  Внутренний модуль: общий для HoldLedger и PgHoldLedger, из основного входа не экспортируется. */
export function units(m: Money, min: number): number {
  if (!m || !Number.isSafeInteger(m.amount) || m.amount < min) throw new HoldError("BAD_AMOUNT");
  if (!isCurrencyCode(m.currency)) throw new HoldError("BAD_CURRENCY");
  return m.amount;
}
