import { canonicalJson, sha256Hex } from "./canonical.js";

/** Идемпотентность изменяющих операций: тот же ключ + то же тело → прежний результат; другое тело → конфликт. */
export class IdempotencyConflict extends Error { constructor() { super("IDEMPOTENCY_CONFLICT"); } }

export class IdempotencyStore<R = unknown> {
  private rows = new Map<string, { bodyHash: string; result: R; at: number }>();
  constructor(private ttlMs = 24 * 3600 * 1000, private now: () => number = () => Date.now()) {}

  run(key: string, body: unknown, fn: () => R): { result: R; replayed: boolean } {
    if (!key) throw new Error("IDEMPOTENCY_REQUIRED");
    const bodyHash = sha256Hex(canonicalJson(body));
    const hit = this.rows.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) {
      if (hit.bodyHash !== bodyHash) throw new IdempotencyConflict();
      return { result: hit.result, replayed: true };
    }
    const result = fn();
    this.rows.set(key, { bodyHash, result, at: this.now() });
    return { result, replayed: false };
  }
}
