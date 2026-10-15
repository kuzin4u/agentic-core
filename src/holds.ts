import { isCurrencyCode, type CurrencyCode, type Money } from "./money.js";

/** Учёт удержаний: резерв → закрепление → освобождение.
 *  Один механизм для бюджета мандата (Платформа ПС, П3) и для эскроу (НСВР, BankAdapter).
 *  Инварианты: доступно = лимит − закреплено − зарезервировано ≥ 0; операции атомарны и идемпотентны по ref.
 *  Суммы (К9) — целые минимальные единицы; счёт и его удержания — в одной валюте. */
export type HoldState = "RESERVED" | "COMMITTED" | "RELEASED" | "PARTIAL";

export interface Hold {
  id: string;
  account: string;
  ref: string;
  currency: CurrencyCode;
  amount: number;      // зарезервировано изначально, минимальные единицы
  committed: number;   // закреплено
  released: number;    // освобождено
  state: HoldState;
  expires_at: number | null; // epoch ms
}

export interface Account { id: string; currency: CurrencyCode; limit: number; committed: number; reserved: number; version: number; }

export class HoldError extends Error {
  constructor(public code: "INSUFFICIENT" | "UNKNOWN_ACCOUNT" | "UNKNOWN_HOLD" | "BAD_AMOUNT" | "BAD_STATE" | "REF_CONFLICT" | "CURRENCY_MISMATCH" | "ACCOUNT_CONFLICT" | "BAD_CURRENCY", msg?: string) { super(msg ?? code); }
}

/** Сумма из Money: безопасное целое ≥ min, иначе BAD_AMOUNT; код валюты — как в money, иначе BAD_CURRENCY. */
function units(m: Money, min: number): number {
  if (!m || !Number.isSafeInteger(m.amount) || m.amount < min) throw new HoldError("BAD_AMOUNT");
  if (!isCurrencyCode(m.currency)) throw new HoldError("BAD_CURRENCY");
  return m.amount;
}

export class HoldLedger {
  private accounts = new Map<string, Account>();
  private holds = new Map<string, Hold>();
  private byRef = new Map<string, string>();
  private seq = 0;

  /** Открытие счёта. Повтор с тем же лимитом и валютой — прежний счёт без изменений; иначе ACCOUNT_CONFLICT (К9 п. 6). */
  openAccount(id: string, limit: Money): Account {
    const n = units(limit, 0);
    const prev = this.accounts.get(id);
    if (prev) {
      if (prev.limit !== n || prev.currency !== limit.currency) throw new HoldError("ACCOUNT_CONFLICT");
      return { ...prev };
    }
    const a = { id, currency: limit.currency, limit: n, committed: 0, reserved: 0, version: 0 };
    this.accounts.set(id, a);
    return { ...a };
  }

  available(id: string): Money {
    const a = this.acc(id);
    return { amount: a.limit - a.committed - a.reserved, currency: a.currency };
  }

  account(id: string): Account { return { ...this.acc(id) }; }

  /** Резерв. Повтор с тем же ref, суммой и валютой возвращает прежний резерв (идемпотентность). */
  reserve(account: string, money: Money, ref: string, expires_at: number | null = null): Hold {
    const amount = units(money, 1);
    const existing = this.byRef.get(ref);
    if (existing) {
      const h = this.holds.get(existing)!;
      if (h.account !== account || h.amount !== amount || h.currency !== money.currency) throw new HoldError("REF_CONFLICT");
      return { ...h };
    }
    const a = this.acc(account);
    if (money.currency !== a.currency) throw new HoldError("CURRENCY_MISMATCH");
    if (a.limit - a.committed - a.reserved < amount) throw new HoldError("INSUFFICIENT");
    a.reserved += amount; a.version++;
    const h: Hold = { id: `HLD-${++this.seq}`, account, ref, currency: a.currency, amount, committed: 0, released: 0, state: "RESERVED", expires_at };
    this.holds.set(h.id, h); this.byRef.set(ref, h.id);
    return { ...h };
  }

  /** Закрепление (клиринг / раскрытие эскроу). Частичное допустимо; остаток можно освободить releaseRest. */
  commit(holdId: string, money: Money, releaseRest = false): Hold {
    const h = this.hold(holdId);
    const open = h.amount - h.committed - h.released;
    if (open === 0) throw new HoldError("BAD_STATE");
    const amount = units(money, 1);
    if (money.currency !== h.currency) throw new HoldError("CURRENCY_MISMATCH");
    if (amount > open) throw new HoldError("BAD_AMOUNT");
    const a = this.acc(h.account);
    a.reserved -= amount; a.committed += amount; h.committed += amount;
    if (releaseRest && open - amount > 0) { const rest = open - amount; a.reserved -= rest; h.released += rest; }
    h.state = h.committed === h.amount ? "COMMITTED" : "PARTIAL";
    a.version++;
    return { ...h };
  }

  /** Освобождение открытой части (реверсал, отказ, возврат депоненту, истечение). */
  release(holdId: string): Hold {
    const h = this.hold(holdId);
    const open = h.amount - h.committed - h.released;
    if (open === 0) return { ...h }; // идемпотентно
    const a = this.acc(h.account);
    a.reserved -= open; h.released += open; a.version++;
    h.state = h.committed > 0 ? "PARTIAL" : "RELEASED";
    return { ...h };
  }

  /** Освобождение всех истёкших резервов на момент now. */
  expire(now: number): Hold[] {
    const out: Hold[] = [];
    for (const h of this.holds.values()) {
      if (h.expires_at !== null && h.expires_at <= now && h.amount - h.committed - h.released > 0) out.push(this.release(h.id));
    }
    return out;
  }

  get(holdId: string): Hold { return { ...this.hold(holdId) }; }

  private acc(id: string) { const a = this.accounts.get(id); if (!a) throw new HoldError("UNKNOWN_ACCOUNT"); return a; }
  private hold(id: string) { const h = this.holds.get(id); if (!h) throw new HoldError("UNKNOWN_HOLD"); return h; }
}
