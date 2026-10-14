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

/** Начало именованной цепочки (К6 п. 8): первая запись привязана к имени, строки чужой цепочки под этим именем не проходят verify(). */
export function chainGenesis(chain: string): string {
  return sha256Hex("core_journal:" + chain);
}

/** Хранилище с асинхронным доступом (К6 п. 4): PostgreSQL и другие внешние базы. */
export interface AsyncJournalStore {
  /** prev_hash первой записи; по умолчанию GENESIS_HASH. */
  readonly genesis?: string;
  last(): Promise<JournalEntry | undefined>;
  /** Запись с занятым seq или prev_hash — JournalAppendConflict. */
  append(e: JournalEntry): Promise<void>;
  /** Все записи по возрастанию seq: verify() полагается на порядок и не сортирует сам. */
  all(): Promise<readonly JournalEntry[]>;
}

/** Конец цепочки занят другой записью: одновременное добавление (К6 п. 7). */
export class JournalAppendConflict extends Error {
  constructor(public readonly seq: number) { super(`JOURNAL_APPEND_CONFLICT: seq ${seq}`); }
}

export class AsyncMemoryJournalStore implements AsyncJournalStore {
  private rows: JournalEntry[] = [];
  constructor(readonly genesis: string = GENESIS_HASH) {}
  async last() { return this.rows[this.rows.length - 1]; }
  async append(e: JournalEntry) {
    const tail = this.rows[this.rows.length - 1];
    if (e.seq !== (tail ? tail.seq + 1 : 1) || e.prev_hash !== (tail ? tail.hash : this.genesis)) throw new JournalAppendConflict(e.seq);
    this.rows.push(Object.freeze({ ...e }) as JournalEntry);
  }
  async all() { return this.rows; }
}

export type JournalVerifyResult = { ok: true } | { ok: false; brokenAt: number };

/** Внешний якорь (К6 п. 9): последние seq и hash, которые потребитель хранит отдельно или получает из подписанной выписки. */
export interface JournalAnchor { seq: number; hash: string }

/** HashChainJournal над асинхронным хранилищем: те же append, verify, extract. */
export class AsyncHashChainJournal {
  constructor(
    private store: AsyncJournalStore,
    private now: () => string = () => new Date().toISOString(),
    private maxAttempts = 5,
  ) {}

  private get genesis() { return this.store.genesis ?? GENESIS_HASH; }

  /** При одновременном добавлении перечитывает конец цепочки и повторяет; сверх maxAttempts — JournalAppendConflict вызывающему. */
  async append<T>(kind: string, ref: string, payload: T, parent_ref: string | null = null): Promise<JournalEntry<T>> {
    for (let attempt = 1; ; attempt++) {
      const prev = await this.store.last();
      const base = { seq: prev ? prev.seq + 1 : 1, at: this.now(), kind, ref, parent_ref, payload, prev_hash: prev ? prev.hash : this.genesis };
      const e = { ...base, hash: entryHash(base) } as JournalEntry<T>;
      try {
        await this.store.append(e);
        return e;
      } catch (err) {
        if (!(err instanceof JournalAppendConflict) || attempt >= this.maxAttempts) throw err;
      }
    }
  }

  /** Проверка целостности: начало цепочки, непрерывный seq, ссылка на хэш предыдущей, пересчёт хэша.
   *  С якорем — ещё и запись anchor.seq существует и её hash равен якорному; рост цепочки после якоря — не ошибка.
   *  Без якоря удалённый хвост не обнаружить (К6 п. 9). */
  async verify(anchor?: JournalAnchor): Promise<JournalVerifyResult> {
    if (anchor && !(Number.isInteger(anchor.seq) && anchor.seq >= 1)) throw new RangeError(`JOURNAL_ANCHOR_INVALID: seq ${anchor.seq}, нужен целый seq ≥ 1`);
    let prev = this.genesis;
    let seq = 0;
    for (const e of await this.store.all()) {
      const { hash, ...rest } = e;
      if (e.seq !== seq + 1 || e.prev_hash !== prev || entryHash(rest) !== hash) return { ok: false, brokenAt: e.seq };
      if (anchor && e.seq === anchor.seq && hash !== anchor.hash) return { ok: false, brokenAt: anchor.seq };
      prev = hash;
      seq = e.seq;
    }
    if (anchor && seq < anchor.seq) return { ok: false, brokenAt: anchor.seq };
    return { ok: true };
  }

  async extract(ref: string): Promise<JournalEntry[]> {
    const refs = new Set([ref]);
    const out: JournalEntry[] = [];
    for (const e of await this.store.all()) {
      if (refs.has(e.ref) || (e.parent_ref && refs.has(e.parent_ref))) { refs.add(e.ref); out.push(e); }
    }
    return out;
  }
}
