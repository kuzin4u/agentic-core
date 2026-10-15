import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { idempotencyOptions } from "./idempotency-options.js";

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

/** Тот же ключ ещё выполняется (К6 п. 11): одновременный вызов, пока первый не завершён и его аренда не истекла. */
export class IdempotencyInProgress extends Error { constructor() { super("IDEMPOTENCY_IN_PROGRESS"); } }

export interface IdempotencyOptions {
  /** Срок хранения результата, мс (по умолчанию 24 ч). */
  ttlMs?: number;
  /** Аренда захвата, мс (по умолчанию 60 с, не больше ttlMs): упавший во время fn процесс не держит ключ дольше.
   *  Должна быть больше самой долгой fn — иначе по истечении аренды fn выполнится второй раз. */
  leaseMs?: number;
  now?: () => number;
}

/** Идемпотентность с асинхронной fn и хранилищем (К6 пп. 4, 11). Результат — значение JSON: повтор возвращает его разбор. */
export interface AsyncIdempotencyStore<R = unknown> {
  run(key: string, body: unknown, fn: () => Promise<R>): Promise<{ result: R; replayed: boolean }>;
}

type Row = { bodyHash: string; state: "RUNNING" | "DONE"; token: string; result: string | null; at: number };

/** В памяти — тот же порядок, что у PgIdempotencyStore: захват, «выполняется», аренда, запись только владельцем захвата. */
export class AsyncMemoryIdempotencyStore<R = unknown> implements AsyncIdempotencyStore<R> {
  private rows = new Map<string, Row>();
  private o: Required<IdempotencyOptions>;
  constructor(opts?: IdempotencyOptions) { this.o = idempotencyOptions(opts); }

  async run(key: string, body: unknown, fn: () => Promise<R>): Promise<{ result: R; replayed: boolean }> {
    if (!key) throw new Error("IDEMPOTENCY_REQUIRED");
    const bodyHash = sha256Hex(canonicalJson(body));
    const now = this.o.now();
    const hit = this.rows.get(key);
    const free = !hit || (hit.state === "DONE" ? hit.at <= now - this.o.ttlMs : hit.at <= now - this.o.leaseMs);
    if (!free) {
      if (hit.bodyHash !== bodyHash) throw new IdempotencyConflict();
      if (hit.state === "RUNNING") throw new IdempotencyInProgress();
      return { result: JSON.parse(hit.result!) as R, replayed: true };
    }
    const token = randomUUID();
    this.rows.set(key, { bodyHash, state: "RUNNING", token, result: null, at: now });
    let result: R;
    try { result = await fn(); } catch (e) {
      if (this.rows.get(key)?.token === token) this.rows.delete(key);
      throw e;
    }
    if (this.rows.get(key)?.token === token) this.rows.set(key, { bodyHash, state: "DONE", token, result: canonicalJson(result ?? null), at: this.o.now() });
    return { result, replayed: false };
  }
}
