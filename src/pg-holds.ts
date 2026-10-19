import { HoldError, type Account, type AsyncHoldLedger, type Hold, type HoldState } from "./holds.js";
import { instant, units } from "./holds-input.js";
import type { Money } from "./money.js";
import type { SqlClient } from "./sql.js";

type AccountRow = { id: string; currency: string; limit_amount: string; committed: string; reserved: string; version: string };
type HoldRow = { seq: string; account: string; ref: string; currency: string; amount: string; committed: string; released: string; state: string; expires_at: string | null };

const UNIQUE_VIOLATION = "23505";
const ATTEMPTS = 5;
const HOLD_COLS = "seq, account, ref, currency, amount, committed, released, state, expires_at";

/** node-postgres отдаёт bigint строкой: число вне безопасного диапазона — ошибка, а не тихая потеря точности (К6 п. 10). */
function int(v: string | number): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`core_holds: значение ${v} вне Number.MAX_SAFE_INTEGER`);
  return n;
}

const toAccount = (r: AccountRow): Account => ({
  id: r.id, currency: r.currency, limit: int(r.limit_amount), committed: int(r.committed), reserved: int(r.reserved), version: int(r.version),
});

const toHold = (r: HoldRow): Hold => ({
  id: `HLD-${r.seq}`, account: r.account, ref: r.ref, currency: r.currency, amount: int(r.amount), committed: int(r.committed),
  released: int(r.released), state: r.state as HoldState, expires_at: r.expires_at === null ? null : int(r.expires_at),
});

const BIGINT_MAX = 2n ** 63n - 1n;

/** Номер строки из id удержания; чужой формат и номер вне bigint — UNKNOWN_HOLD, как у HoldLedger. */
function seqOf(holdId: string): string {
  const m = /^HLD-([1-9]\d{0,18})$/.exec(holdId);
  if (!m || BigInt(m[1]!) > BIGINT_MAX) throw new HoldError("UNKNOWN_HOLD");
  return m[1]!;
}

/** Удержания в таблицах core_hold_accounts и core_holds (sql/002_holds.sql, К6 п. 10).
 *  Каждая операция — одна SQL-команда: условие по остатку и изменение счёта и удержания — в одном операторе,
 *  под блокировкой строки. Если оператор ничего не изменил, код ошибки определяется чтением — тем же порядком
 *  проверок, что у HoldLedger; если по чтению операция теперь прошла бы (остаток освободился), оператор повторяется.
 *  client — пул или соединение в autocommit, не клиент внутри транзакции потребителя: ошибка повтора ref (23505)
 *  прервала бы его транзакцию, и чтение прежнего удержания упало бы вместо идемпотентного ответа. */
export class PgHoldLedger implements AsyncHoldLedger {
  constructor(private client: SqlClient) {}

  async openAccount(id: string, limit: Money): Promise<Account> {
    const n = units(limit, 0);
    for (let i = 0; i < ATTEMPTS; i++) {
      const r = await this.client.query<AccountRow & { created: boolean }>(
        `WITH ins AS (
           INSERT INTO core_hold_accounts (id, currency, limit_amount) VALUES ($1, $2, $3::bigint)
           ON CONFLICT (id) DO NOTHING RETURNING *)
         SELECT *, true AS created FROM ins
         UNION ALL
         SELECT *, false AS created FROM core_hold_accounts WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM ins)`,
        [id, limit.currency, n],
      );
      const row = r.rows[0];
      // пусто — счёт создан одновременным вызовом после снимка оператора; следующая попытка его увидит
      if (!row) continue;
      const a = toAccount(row);
      if (!row.created && (a.limit !== n || a.currency !== limit.currency)) throw new HoldError("ACCOUNT_CONFLICT");
      return a;
    }
    throw new Error("core_holds: openAccount не завершён за отведённое число попыток");
  }

  /** Изменение предела (К20 п. 3): условие «не ниже использованного» и смена предела — в одном UPDATE под блокировкой
   *  строки счёта; одновременный reserve ждёт её и перепроверяет свой остаток по новому пределу. Тот же предел —
   *  оператор ничего не меняет, счёт возвращается чтением (version та же). */
  async setLimit(id: string, limit: Money): Promise<Account> {
    const n = units(limit, 0);
    for (let i = 0; i < ATTEMPTS; i++) {
      const r = await this.client.query<AccountRow>(
        `UPDATE core_hold_accounts SET limit_amount = $2::bigint, version = version + 1
         WHERE id = $1 AND currency = $3 AND committed + reserved <= $2::bigint AND limit_amount <> $2::bigint
         RETURNING *`,
        [id, n, limit.currency],
      );
      if (r.rows[0]) return toAccount(r.rows[0]);
      // ничего не изменено: причина — тем же порядком проверок, что у HoldLedger
      const a = await this.account(id);
      if (limit.currency !== a.currency) throw new HoldError("CURRENCY_MISMATCH");
      if (n < a.committed + a.reserved) throw new HoldError("LIMIT_BELOW_USED");
      if (n === a.limit) return a;
    }
    throw new Error("core_holds: setLimit не завершён за отведённое число попыток");
  }

  async account(id: string): Promise<Account> {
    const r = await this.client.query<AccountRow>("SELECT * FROM core_hold_accounts WHERE id = $1", [id]);
    if (!r.rows[0]) throw new HoldError("UNKNOWN_ACCOUNT");
    return toAccount(r.rows[0]);
  }

  async available(id: string): Promise<Money> {
    const a = await this.account(id);
    return { amount: a.limit - a.committed - a.reserved, currency: a.currency };
  }

  async get(holdId: string): Promise<Hold> {
    const r = await this.client.query<HoldRow>(`SELECT ${HOLD_COLS} FROM core_holds WHERE seq = $1::bigint`, [seqOf(holdId)]);
    if (!r.rows[0]) throw new HoldError("UNKNOWN_HOLD");
    return toHold(r.rows[0]);
  }

  /** Резерв: остаток проверяется в том же UPDATE, что увеличивает reserved; удержание вставляется тем же оператором.
   *  Повтор ref одновременно — нарушение UNIQUE(ref) откатывает оператор целиком, затем — чтение прежнего удержания. */
  async reserve(account: string, money: Money, ref: string, expires_at: number | null = null): Promise<Hold> {
    const amount = units(money, 1);
    instant(expires_at, true, "expires_at");
    for (let i = 0; i < ATTEMPTS; i++) {
      try {
        const r = await this.client.query<HoldRow>(
          `WITH a AS (
             UPDATE core_hold_accounts SET reserved = reserved + $3::bigint, version = version + 1
             WHERE id = $1 AND currency = $4 AND limit_amount - committed - reserved >= $3::bigint
               AND NOT EXISTS (SELECT 1 FROM core_holds WHERE ref = $2)
             RETURNING id, currency)
           INSERT INTO core_holds (account, ref, currency, amount, state, expires_at)
           SELECT id, $2, currency, $3::bigint, 'RESERVED', $5::bigint FROM a
           RETURNING ${HOLD_COLS}`,
          [account, ref, amount, money.currency, expires_at],
        );
        if (r.rows[0]) return toHold(r.rows[0]);
      } catch (err) {
        if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
      }
      // ничего не изменено: причина — тем же порядком проверок, что у HoldLedger
      const h = await this.client.query<HoldRow>(`SELECT ${HOLD_COLS} FROM core_holds WHERE ref = $1`, [ref]);
      if (h.rows[0]) {
        const prev = toHold(h.rows[0]);
        if (prev.account !== account || prev.amount !== amount || prev.currency !== money.currency) throw new HoldError("REF_CONFLICT");
        return prev;
      }
      const a = await this.account(account);
      if (money.currency !== a.currency) throw new HoldError("CURRENCY_MISMATCH");
      if (a.limit - a.committed - a.reserved < amount) throw new HoldError("INSUFFICIENT");
    }
    throw new Error("core_holds: reserve не завершён за отведённое число попыток");
  }

  /** Закрепление: строка удержания блокируется (FOR UPDATE), открытая часть берётся из неё; удержание и счёт — одним оператором. */
  async commit(holdId: string, money: Money, releaseRest = false): Promise<Hold> {
    const seq = seqOf(holdId);
    let amount: number;
    try { amount = units(money, 1); } catch (e) {
      // порядок HoldLedger: неизвестное или закрытое удержание — раньше проверки суммы
      const h = await this.get(holdId);
      if (h.amount - h.committed - h.released === 0) throw new HoldError("BAD_STATE");
      throw e;
    }
    for (let i = 0; i < ATTEMPTS; i++) {
      const r = await this.client.query<HoldRow>(
        `WITH o AS (
           SELECT seq, account, amount - committed - released AS open FROM core_holds
           WHERE seq = $1::bigint AND currency = $4 FOR UPDATE),
         h AS (
           UPDATE core_holds t SET
             committed = t.committed + $2::bigint,
             released = t.released + CASE WHEN $3::boolean THEN o.open - $2::bigint ELSE 0 END,
             state = CASE WHEN t.committed + $2::bigint = t.amount THEN 'COMMITTED' ELSE 'PARTIAL' END
           FROM o WHERE t.seq = o.seq AND o.open >= $2::bigint
           RETURNING t.seq, t.account, t.ref, t.currency, t.amount, t.committed, t.released, t.state, t.expires_at, o.open),
         a AS (
           UPDATE core_hold_accounts acc SET
             committed = acc.committed + $2::bigint,
             reserved = acc.reserved - $2::bigint - CASE WHEN $3::boolean THEN h.open - $2::bigint ELSE 0 END,
             version = acc.version + 1
           FROM h WHERE acc.id = h.account)
         SELECT ${HOLD_COLS} FROM h`,
        [seq, amount, releaseRest, money.currency],
      );
      if (r.rows[0]) return toHold(r.rows[0]);
      const h = await this.get(holdId);
      const open = h.amount - h.committed - h.released;
      if (open === 0) throw new HoldError("BAD_STATE");
      if (money.currency !== h.currency) throw new HoldError("CURRENCY_MISMATCH");
      if (amount > open) throw new HoldError("BAD_AMOUNT");
    }
    throw new Error("core_holds: commit не завершён за отведённое число попыток");
  }

  /** Освобождение открытой части; закрытое удержание возвращается без изменений (идемпотентно). */
  async release(holdId: string): Promise<Hold> {
    const r = await this.client.query<HoldRow>(
      `WITH o AS (
         SELECT seq, account, amount - committed - released AS open FROM core_holds WHERE seq = $1::bigint FOR UPDATE),
       h AS (
         UPDATE core_holds t SET released = t.released + o.open, state = CASE WHEN t.committed > 0 THEN 'PARTIAL' ELSE 'RELEASED' END
         FROM o WHERE t.seq = o.seq AND o.open > 0
         RETURNING t.seq, t.account, t.ref, t.currency, t.amount, t.committed, t.released, t.state, t.expires_at, o.open),
       a AS (
         UPDATE core_hold_accounts acc SET reserved = acc.reserved - h.open, version = acc.version + 1
         FROM h WHERE acc.id = h.account)
       SELECT ${HOLD_COLS} FROM h`,
      [seqOf(holdId)],
    );
    return r.rows[0] ? toHold(r.rows[0]) : this.get(holdId);
  }

  /** Освобождение всех истёкших открытых удержаний на момент now — одним оператором; строки блокируются по порядку seq. */
  async expire(now: number): Promise<Hold[]> {
    instant(now, false, "now");
    const r = await this.client.query<HoldRow>(
      `WITH o AS (
         SELECT seq, account, amount - committed - released AS open FROM core_holds
         WHERE expires_at IS NOT NULL AND expires_at <= $1::bigint AND committed + released < amount
         ORDER BY seq FOR UPDATE),
       h AS (
         UPDATE core_holds t SET released = t.released + o.open, state = CASE WHEN t.committed > 0 THEN 'PARTIAL' ELSE 'RELEASED' END
         FROM o WHERE t.seq = o.seq AND o.open > 0
         RETURNING t.seq, t.account, t.ref, t.currency, t.amount, t.committed, t.released, t.state, t.expires_at, o.open),
       s AS (SELECT account, sum(open) AS total, count(*) AS n FROM h GROUP BY account),
       a AS (
         UPDATE core_hold_accounts acc SET reserved = acc.reserved - s.total, version = acc.version + s.n
         FROM s WHERE acc.id = s.account)
       SELECT ${HOLD_COLS} FROM h ORDER BY seq`,
      [now],
    );
    return r.rows.map(toHold);
  }
}
