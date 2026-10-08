import { canonicalJson, sha256Hex } from "./canonical.js";

/** Неизменяемый журнал с хэш-цепочкой (журнал согласий, история сделки, журнал испытаний).
 *  Только добавление. Изменение = новая запись со ссылкой parent_ref. */
export interface JournalEntry<T = unknown> {
  seq: number;
  at: string;
  kind: string;
  ref: string;
  parent_ref: string | null;
  payload: T;
  prev_hash: string;
  hash: string;
}

export const GENESIS_HASH = "0".repeat(64);

export function entryHash(e: Omit<JournalEntry, "hash">): string {
  return sha256Hex(canonicalJson({ seq: e.seq, at: e.at, kind: e.kind, ref: e.ref, parent_ref: e.parent_ref, payload: e.payload, prev_hash: e.prev_hash }));
}

export interface JournalStore {
  last(): JournalEntry | undefined;
  append(e: JournalEntry): void;
  all(): readonly JournalEntry[];
}

export class MemoryJournalStore implements JournalStore {
  private rows: JournalEntry[] = [];
  last() { return this.rows[this.rows.length - 1]; }
  append(e: JournalEntry) { this.rows.push(Object.freeze({ ...e }) as JournalEntry); }
  all() { return this.rows; }
}

export class HashChainJournal {
  constructor(private store: JournalStore = new MemoryJournalStore(), private now: () => string = () => new Date().toISOString()) {}

  append<T>(kind: string, ref: string, payload: T, parent_ref: string | null = null): JournalEntry<T> {
    const prev = this.store.last();
    const base = { seq: prev ? prev.seq + 1 : 1, at: this.now(), kind, ref, parent_ref, payload, prev_hash: prev ? prev.hash : GENESIS_HASH };
    const e = { ...base, hash: entryHash(base) } as JournalEntry<T>;
    this.store.append(e);
    return e;
  }

  /** Проверка целостности: каждая запись ссылается на хэш предыдущей и её хэш пересчитывается. */
  verify(): { ok: true } | { ok: false; brokenAt: number } {
    let prev = GENESIS_HASH;
    for (const e of this.store.all()) {
      const { hash, ...rest } = e;
      if (e.prev_hash !== prev || entryHash(rest) !== hash) return { ok: false, brokenAt: e.seq };
      prev = hash;
    }
    return { ok: true };
  }

  /** Цепочка записей по ref и его потомкам через parent_ref (выписка для спора). */
  extract(ref: string): JournalEntry[] {
    const refs = new Set([ref]);
    const out: JournalEntry[] = [];
    for (const e of this.store.all()) {
      if (refs.has(e.ref) || (e.parent_ref && refs.has(e.parent_ref))) { refs.add(e.ref); out.push(e); }
    }
    return out;
  }
}
