import type { AsyncNonceStore, NonceStoreOptions } from "./signing.js";
import { nonceStoreOptions } from "./nonce-options.js";
import type { SqlClient } from "./sql.js";

/** Использованные nonce в таблице core_nonces (sql/004_nonces.sql, К6 п. 12), область — scope потребителя.
 *  seen — одной командой: вставка без конфликта — nonce новый; конфликт — уже был. */
export class PgNonceStore implements AsyncNonceStore {
  private o: { retainMs: number; now: () => number };
  constructor(private client: SqlClient, readonly scope: string, opts: NonceStoreOptions) { this.o = nonceStoreOptions(opts); }

  async seen(nonce: string): Promise<boolean> {
    if (!nonce) return true;
    const r = await this.client.query(
      "INSERT INTO core_nonces (scope, nonce, at) VALUES ($1, $2, $3::bigint) ON CONFLICT DO NOTHING RETURNING 1 AS fresh",
      [this.scope, nonce, this.o.now()],
    );
    return r.rows.length === 0;
  }

  async purge(): Promise<number> {
    const r = await this.client.query<{ n: number }>(
      "WITH d AS (DELETE FROM core_nonces WHERE scope = $1 AND at < $2::bigint RETURNING 1) SELECT count(*)::int AS n FROM d",
      [this.scope, this.o.now() - this.o.retainMs],
    );
    return r.rows[0]!.n;
  }
}
