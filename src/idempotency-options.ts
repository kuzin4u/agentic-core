import type { IdempotencyOptions } from "./idempotency.js";

/** Параметры по умолчанию и проверка; общая для памяти и PG. Внутренний модуль: из основного входа не экспортируется. */
export function idempotencyOptions(o: IdempotencyOptions = {}): Required<IdempotencyOptions> {
  const r = { ttlMs: o.ttlMs ?? 24 * 3600 * 1000, leaseMs: o.leaseMs ?? 60_000, now: o.now ?? (() => Date.now()) };
  if (!(Number.isSafeInteger(r.ttlMs) && r.ttlMs > 0)) throw new RangeError("ttlMs — положительное целое");
  if (!(Number.isSafeInteger(r.leaseMs) && r.leaseMs > 0 && r.leaseMs <= r.ttlMs)) throw new RangeError("leaseMs — положительное целое, не больше ttlMs");
  return r;
}
