// Договор AsyncIdempotencyStore (К6 п. 11): одни и те же случаи для памяти и PostgreSQL.
import { it, expect } from "vitest";
import { IdempotencyConflict, IdempotencyInProgress, type AsyncIdempotencyStore, type IdempotencyOptions } from "../src/index.js";

export type MakeStore = (opts: IdempotencyOptions) => AsyncIdempotencyStore<{ n: number }>;

/** Ворота: fn ждёт, пока тест не откроет. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => { open = r; });
  return { p, open };
}

export function idempotencyContract(make: MakeStore) {
  it("тот же ключ и тело — прежний результат; другое тело — конфликт; fn один раз", async () => {
    const S = make({}); let calls = 0;
    expect(await S.run("k", { a: 1 }, async () => ({ n: ++calls }))).toEqual({ result: { n: 1 }, replayed: false });
    expect(await S.run("k", { a: 1 }, async () => ({ n: ++calls }))).toEqual({ result: { n: 1 }, replayed: true });
    await expect(S.run("k", { a: 2 }, async () => ({ n: ++calls }))).rejects.toBeInstanceOf(IdempotencyConflict);
    await expect(S.run("", { a: 1 }, async () => ({ n: ++calls }))).rejects.toThrow("IDEMPOTENCY_REQUIRED");
    expect(calls).toBe(1);
  });

  it("10 одновременных с одним ключом: fn один раз, остальные — IdempotencyInProgress; после — повтор", async () => {
    const S = make({}); let calls = 0; const g = gate(); const started = gate();
    const first = S.run("k", { a: 1 }, async () => { calls++; started.open(); await g.p; return { n: 7 }; });
    await started.p; // ключ захвачен первым
    const rest = await Promise.allSettled(Array.from({ length: 9 }, () => S.run("k", { a: 1 }, async () => ({ n: ++calls }))));
    for (const r of rest) expect(r.status === "rejected" && r.reason).toBeInstanceOf(IdempotencyInProgress);
    await expect(S.run("k", { a: 2 }, async () => ({ n: 0 }))).rejects.toBeInstanceOf(IdempotencyConflict);
    g.open();
    expect(await first).toEqual({ result: { n: 7 }, replayed: false });
    expect(await S.run("k", { a: 1 }, async () => ({ n: ++calls }))).toEqual({ result: { n: 7 }, replayed: true });
    expect(calls).toBe(1);
  });

  it("упавшая fn снимает захват: повтор выполняет fn снова", async () => {
    const S = make({}); let calls = 0;
    await expect(S.run("k", {}, async () => { calls++; throw new Error("сбой"); })).rejects.toThrow("сбой");
    expect(await S.run("k", {}, async () => ({ n: ++calls }))).toEqual({ result: { n: 2 }, replayed: false });
  });

  it("истечение ttl результата — по поддельным часам", async () => {
    let t = 1_000_000; const S = make({ ttlMs: 10_000, leaseMs: 1_000, now: () => t }); let calls = 0;
    await S.run("k", {}, async () => ({ n: ++calls }));
    t += 9_999;
    expect((await S.run("k", {}, async () => ({ n: ++calls }))).replayed).toBe(true);
    t += 1;
    expect(await S.run("k", { other: true }, async () => ({ n: ++calls }))).toEqual({ result: { n: 2 }, replayed: false });
  });

  it("истёкшая аренда (процесс упал во время fn) — ключ перезахватывается; опоздавший результат не записывается", async () => {
    let t = 1_000_000; const S = make({ ttlMs: 60_000, leaseMs: 5_000, now: () => t }); const g = gate(); const started = gate();
    const stale = S.run("k", {}, async () => { started.open(); await g.p; return { n: 1 }; });
    await started.p;
    t += 4_999;
    await expect(S.run("k", {}, async () => ({ n: 2 }))).rejects.toBeInstanceOf(IdempotencyInProgress);
    t += 1;
    expect(await S.run("k", {}, async () => ({ n: 2 }))).toEqual({ result: { n: 2 }, replayed: false });
    g.open();
    expect(await stale).toEqual({ result: { n: 1 }, replayed: false }); // вызывающий получает свой результат,
    expect(await S.run("k", {}, async () => ({ n: 3 }))).toEqual({ result: { n: 2 }, replayed: true }); // но в хранилище — результат владельца
  });

  it("первый ответ и повтор — один и тот же разбор JSON (/audit № 11)", async () => {
    const S = make({}) as unknown as AsyncIdempotencyStore<unknown>;
    const first = await S.run("d", {}, async () => ({ b: [1, { z: null }], a: "я", none: undefined }));
    const again = await S.run("d", {}, async () => 0);
    expect(first.result).toStrictEqual({ a: "я", b: [1, { z: null }] }); // поле undefined отброшено и в первом ответе
    expect(again).toStrictEqual({ result: first.result, replayed: true });
    expect((await S.run("u", {}, async () => undefined)).result).toBeNull();
  });

  it("параметры: leaseMs больше ttlMs или не положительное — RangeError", () => {
    expect(() => make({ ttlMs: 1_000, leaseMs: 2_000 })).toThrow(RangeError);
    expect(() => make({ leaseMs: 0 })).toThrow(RangeError);
  });
}
