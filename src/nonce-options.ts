import type { NonceStoreOptions } from "./signing.js";

/** Проверка параметров хранилища nonce; общая для памяти и PG. Внутренний модуль: из основного входа не экспортируется. */
export function nonceStoreOptions(o: NonceStoreOptions): { retainMs: number; now: () => number } {
  if (!(Number.isSafeInteger(o.retainMs) && o.retainMs > 0)) throw new RangeError("retainMs — положительное целое");
  if (o.skewSec !== undefined && !(Number.isFinite(o.skewSec) && o.skewSec > 0)) throw new RangeError("skewSec — положительное число секунд");
  if (o.skewSec !== undefined && o.retainMs < 2 * o.skewSec * 1000) throw new RangeError("retainMs меньше 2 × skewSec: после purge() повтор в пределах окна прошёл бы");
  return { retainMs: o.retainMs, now: o.now ?? (() => Date.now()) };
}
