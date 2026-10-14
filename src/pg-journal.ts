import { canonicalJson } from "./canonical.js";
import { chainGenesis, JournalAppendConflict, type AsyncJournalStore, type JournalEntry } from "./journal.js";
import type { SqlClient } from "./sql.js";

type Row = { seq: string | number; at: string; kind: string; ref: string; parent_ref: string | null; payload: string; prev_hash: string; hash: string };

const COLS = "seq, at, kind, ref, parent_ref, payload, prev_hash, hash";
const UNIQUE_VIOLATION = "23505";

const toEntry = (r: Row): JournalEntry => ({
  seq: Number(r.seq), at: r.at, kind: r.kind, ref: r.ref, parent_ref: r.parent_ref,
  payload: JSON.parse(r.payload), prev_hash: r.prev_hash, hash: r.hash,
});

/** Хранилище журнала в таблице core_journal (sql/001_journal.sql, К6). Одна цепочка — одно значение chain.
 *  Каждая операция — одна SQL-команда; payload хранится канонической строкой JSON. */
export class PgJournalStore implements AsyncJournalStore {
  readonly genesis: string;
  constructor(private client: SqlClient, readonly chain: string) {
    this.genesis = chainGenesis(chain);
  }

  async last(): Promise<JournalEntry | undefined> {
    const r = await this.client.query<Row>(`SELECT ${COLS} FROM core_journal WHERE chain = $1 ORDER BY seq DESC LIMIT 1`, [this.chain]);
    return r.rows[0] && toEntry(r.rows[0]);
  }

  async append(e: JournalEntry): Promise<void> {
    try {
      await this.client.query(
        `INSERT INTO core_journal (chain, ${COLS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [this.chain, e.seq, e.at, e.kind, e.ref, e.parent_ref, canonicalJson(e.payload), e.prev_hash, e.hash],
      );
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new JournalAppendConflict(e.seq);
      throw err;
    }
  }

  async all(): Promise<readonly JournalEntry[]> {
    const r = await this.client.query<Row>(`SELECT ${COLS} FROM core_journal WHERE chain = $1 ORDER BY seq`, [this.chain]);
    return r.rows.map(toEntry);
  }
}
