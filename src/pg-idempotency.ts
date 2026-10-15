import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { IdempotencyConflict, IdempotencyInProgress, type AsyncIdempotencyStore, type IdempotencyOptions } from "./idempotency.js";
import { idempotencyOptions } from "./idempotency-options.js";
import type { SqlClient } from "./sql.js";

type Row = { body_hash: string; state: "RUNNING" | "DONE"; token: string; result: string | null };

const ATTEMPTS = 5;

/** Ключи идемпотентности в таблице core_idempotency (sql/003_idempotency.sql, К6 п. 11), область — scope потребителя.
 *  Захват — одной командой: вставка или перезахват истёкшего результата (ttlMs) и истёкшей аренды (leaseMs).
 *  Результат записывает только владелец захвата (token): опоздавший после перезахвата не перезаписывает. */
export class PgIdempotencyStore<R = unknown> implements AsyncIdempotencyStore<R> {
  private o: Required<IdempotencyOptions>;
  constructor(private client: SqlClient, readonly scope: string, opts?: IdempotencyOptions) { this.o = idempotencyOptions(opts); }

  async run(key: string, body: unknown, fn: () => Promise<R>): Promise<{ result: R; replayed: boolean }> {
    if (!key) throw new Error("IDEMPOTENCY_REQUIRED");
    const bodyHash = sha256Hex(canonicalJson(body));
    const token = randomUUID();
    for (let i = 0; i < ATTEMPTS; i++) {
      const now = this.o.now();
      const claim = await this.client.query<{ token: string }>(
        `INSERT INTO core_idempotency (scope, key, body_hash, state, token, at) VALUES ($1, $2, $3, 'RUNNING', $4, $5::bigint)
         ON CONFLICT (scope, key) DO UPDATE SET body_hash = EXCLUDED.body_hash, state = 'RUNNING', token = EXCLUDED.token, result = NULL, at = EXCLUDED.at
         WHERE $6::bigint > 0 AND $7::bigint > 0
         RETURNING token`,
        [this.scope, key, bodyHash, token, now, this.o.ttlMs, this.o.leaseMs],
      );
      if (claim.rows[0]?.token === token) return { result: await this.execute(key, bodyHash, token, fn), replayed: false };
      const r = await this.client.query<Row>("SELECT body_hash, state, token, result FROM core_idempotency WHERE scope = $1 AND key = $2", [this.scope, key]);
      const hit = r.rows[0];
      if (!hit) continue; // захват снят упавшей fn между командами — следующая попытка захватит
      if (hit.body_hash !== bodyHash) throw new IdempotencyConflict();
      if (hit.state === "RUNNING") throw new IdempotencyInProgress();
      return { result: JSON.parse(hit.result!) as R, replayed: true };
    }
    throw new Error("core_idempotency: ключ не захвачен за отведённое число попыток");
  }

  private async execute(key: string, bodyHash: string, token: string, fn: () => Promise<R>): Promise<R> {
    let result: R;
    try { result = await fn(); } catch (e) {
      await this.client.query("DELETE FROM core_idempotency WHERE scope = $1 AND key = $2 AND token = $3", [this.scope, key, token]);
      throw e;
    }
    await this.client.query(
      "UPDATE core_idempotency SET state = 'DONE', result = $4, at = $5::bigint WHERE scope = $1 AND key = $2 AND token = $3 AND body_hash = $6",
      [this.scope, key, token, canonicalJson(result ?? null), this.o.now(), bodyHash],
    );
    return result;
  }
}
