/** Доставка событий «не менее одного раза»: исходящая очередь с повтором и входящий дедупликатор. */
export interface Event<T = unknown> { event_id: string; type: string; at: string; data: T; }

export function nextAttemptDelayMs(attempt: number, baseMs = 1000, capMs = 15 * 60 * 1000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export class Outbox {
  private q: { e: Event; attempts: number; dueAt: number; done: boolean }[] = [];
  constructor(private maxAttempts = 8) {}
  enqueue(e: Event, now: number) { this.q.push({ e, attempts: 0, dueAt: now, done: false }); }

  /** Пытается доставить все готовые события; send возвращает true при успехе. */
  async flush(now: number, send: (e: Event) => Promise<boolean>): Promise<{ delivered: string[]; dead: string[] }> {
    const delivered: string[] = [], dead: string[] = [];
    for (const it of this.q) {
      if (it.done || it.dueAt > now) continue;
      it.attempts++;
      let ok = false;
      try { ok = await send(it.e); } catch { ok = false; }
      if (ok) { it.done = true; delivered.push(it.e.event_id); }
      else if (it.attempts >= this.maxAttempts) { it.done = true; dead.push(it.e.event_id); }
      else it.dueAt = now + nextAttemptDelayMs(it.attempts);
    }
    return { delivered, dead };
  }
  pending() { return this.q.filter((i) => !i.done).length; }
}

export class Inbox {
  private seen = new Set<string>();
  /** true — событие новое и обработано; false — повтор, пропущен. */
  handle(e: Event, fn: (e: Event) => void): boolean {
    if (this.seen.has(e.event_id)) return false;
    fn(e); this.seen.add(e.event_id); return true;
  }
}
