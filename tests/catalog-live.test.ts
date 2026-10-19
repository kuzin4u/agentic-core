// Живая проверка цены и наличия по К15: порт к продавцу, коды LIVE_*, отказ при неясности.
import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import { checkLiveOffer, compareLiveOffer, type CatalogProduct, type LiveOffer, type LiveOfferRequest, type LiveOfferSource } from "../src/catalog/index.js";

const NOW = Date.parse("2026-10-17T12:00:00+03:00");
const now = () => NOW;
const rub = (amount: number) => ({ amount, currency: "RUB" });
const product: CatalogProduct = {
  sku: "tartine", gtin: null, brand: null, model: null, attributes: {}, title: "Тартин", category: "Хлеб",
  price: rub(25000), availability: { inStock: true, quantity: 10 },
  delivery: [{ method: "PICKUP", minDays: 0, maxDays: 0, cost: rub(0) }], updatedAt: "2026-10-17T07:00+03:00",
};
const req: LiveOfferRequest = { sku: "tartine", quantity: 2 };
const live = (patch: Partial<LiveOffer> = {}): LiveOffer => ({
  sku: "tartine", price: rub(25000), availability: { inStock: true, quantity: 5 }, checkedAt: "2026-10-17T11:59:50+03:00", ...patch,
});
const source = (answer: () => unknown): LiveOfferSource & { calls: { req: LiveOfferRequest; signal: AbortSignal }[] } => {
  const calls: { req: LiveOfferRequest; signal: AbortSignal }[] = [];
  return { calls, fetch: (r, signal) => { calls.push({ req: r, signal }); return answer() as Promise<LiveOffer>; } };
};
const check = (answer: unknown, opt = {}) => checkLiveOffer(product, req, source(() => Promise.resolve(answer)), { now, ...opt });
const codes = (r: { ok: boolean; codes?: string[] }) => (r.ok ? [] : r.codes);

describe("checkLiveOffer: сравнение с каталогом", () => {
  it("совпадение — заказ разрешён; offer — копия ответа, один вызов источника с копией запроса и сигналом", async () => {
    const answer = live();
    const s = source(() => Promise.resolve(answer));
    const r = await checkLiveOffer(product, { ...req, region: "77" }, s, { now });
    expect(r).toEqual({ ok: true, offer: live() });
    answer.price.amount = 1;
    expect(r.offer!.price.amount).toBe(25000);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.req).toEqual({ sku: "tartine", quantity: 2, region: "77" });
    expect(s.calls[0]!.signal.aborted).toBe(false);
  });

  it("цена выше — LIVE_PRICE_UP, ниже — LIVE_PRICE_DOWN, на одну минимальную единицу (допуска нет); offer с живой ценой", async () => {
    const up = await check(live({ price: rub(25001) }));
    expect(up).toEqual({ ok: false, codes: ["LIVE_PRICE_UP"], offer: live({ price: rub(25001) }) });
    expect(codes(await check(live({ price: rub(24999) })))).toEqual(["LIVE_PRICE_DOWN"]);
  });

  it("другая валюта — LIVE_CURRENCY без сравнения сумм", async () => {
    expect(codes(await check(live({ price: { amount: 25000, currency: "USD" } })))).toEqual(["LIVE_CURRENCY"]);
    expect(codes(await check(live({ price: { amount: 1, currency: "USD" } })))).toEqual(["LIVE_CURRENCY"]);
  });

  it("нет в наличии — LIVE_OUT_OF_STOCK; количество меньше запрошенного — LIVE_QUANTITY; равно или не сообщено — разрешено", async () => {
    expect(codes(await check(live({ availability: { inStock: false } })))).toEqual(["LIVE_OUT_OF_STOCK"]);
    expect(codes(await check(live({ availability: { inStock: true, quantity: 1 } })))).toEqual(["LIVE_QUANTITY"]);
    expect(codes(await check(live({ availability: { inStock: true, quantity: 0 } })))).toEqual(["LIVE_QUANTITY"]);
    expect((await check(live({ availability: { inStock: true, quantity: 2 } }))).ok).toBe(true);
    expect((await check(live({ availability: { inStock: true } }))).ok).toBe(true);
  });

  it("несколько расхождений — все коды", async () => {
    expect(codes(await check(live({ price: rub(30000), availability: { inStock: false, quantity: 0 } }))))
      .toEqual(["LIVE_PRICE_UP", "LIVE_OUT_OF_STOCK", "LIVE_QUANTITY"]);
  });
});

describe("checkLiveOffer: отказ при неясности", () => {
  it("источник бросил синхронно, отклонил обещание — LIVE_UNAVAILABLE, offer null", async () => {
    const thrower: LiveOfferSource = { fetch: () => { throw new Error("сеть"); } };
    expect(await checkLiveOffer(product, req, thrower, { now })).toEqual({ ok: false, codes: ["LIVE_UNAVAILABLE"], offer: null });
    expect(await checkLiveOffer(product, req, source(() => Promise.reject(new Error("503"))), { now }))
      .toEqual({ ok: false, codes: ["LIVE_UNAVAILABLE"], offer: null });
  });

  it("не ответил за timeoutMs — LIVE_UNAVAILABLE и abort() сигнала; поздний ответ не меняет результат", async () => {
    let late!: (v: LiveOffer) => void;
    const s = source(() => new Promise((res) => { late = res; }));
    const r = await checkLiveOffer(product, req, s, { now, timeoutMs: 20 });
    expect(r).toEqual({ ok: false, codes: ["LIVE_UNAVAILABLE"], offer: null });
    expect(s.calls[0]!.signal.aborted).toBe(true);
    late(live());
  });

  it("ответ не по форме — LIVE_INVALID, offer null", async () => {
    const bad: unknown[] = [
      null, [], "ok", live({ sku: "other" }),
      { ...live(), price: { amount: 250.5, currency: "RUB" } }, { ...live(), price: { amount: -1, currency: "RUB" } },
      { ...live(), price: { amount: "25000", currency: "RUB" } }, { ...live(), price: { amount: 25000, currency: "rub" } },
      { ...live(), price: undefined }, { ...live(), availability: { inStock: "yes" } },
      { ...live(), availability: { inStock: true, quantity: -1 } }, { ...live(), availability: { inStock: true, quantity: 1.5 } },
      { ...live(), checkedAt: "2026-10-17T11:59:50" }, { ...live(), checkedAt: "вчера" }, { ...live(), checkedAt: undefined },
      { ...live(), checkedAt: "2026-10-17T24:00:00+03:00" }, { ...live(), checkedAt: "2026-02-30T11:59:50+03:00" }, // К20 п. 1
      Object.defineProperty(live(), "price", { get() { throw new Error("геттер"); } }),
    ];
    for (const [i, b] of bad.entries()) expect(await check(b), `вход ${i}`).toEqual({ ok: false, codes: ["LIVE_INVALID"], offer: null });
  });

  it("старый ответ или из будущего сверх допуска часов — LIVE_STALE без сравнения; границы включительно разрешены", async () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(codes(await check(live({ checkedAt: at(-60_001), price: rub(1) })))).toEqual(["LIVE_STALE"]);
    expect(codes(await check(live({ checkedAt: at(30_001) })))).toEqual(["LIVE_STALE"]);
    expect((await check(live({ checkedAt: at(-60_000) }))).ok).toBe(true);
    expect((await check(live({ checkedAt: at(30_000) }))).ok).toBe(true);
    expect(codes(await check(live({ checkedAt: at(-1001) }), { maxAgeMs: 1000 }))).toEqual(["LIVE_STALE"]);
  });

  it("часы потребителя бросили или вернули не число — LIVE_UNAVAILABLE, не разрешение", async () => {
    expect(codes(await check(live(), { now: () => { throw new Error("часы"); } }))).toEqual(["LIVE_UNAVAILABLE"]);
    expect(codes(await check(live(), { now: () => NaN }))).toEqual(["LIVE_UNAVAILABLE"]);
  });

  it("ошибка вызова — отказ до обращения к источнику", async () => {
    const s = source(() => Promise.resolve(live()));
    await expect(checkLiveOffer(product, { sku: "tartine", quantity: 0 }, s)).rejects.toThrow(RangeError);
    await expect(checkLiveOffer(product, { sku: "tartine", quantity: 1.5 }, s)).rejects.toThrow(RangeError);
    await expect(checkLiveOffer(product, { sku: "other", quantity: 1 }, s)).rejects.toThrow(TypeError);
    await expect(checkLiveOffer(product, { sku: "tartine", quantity: 1, region: "" }, s)).rejects.toThrow(TypeError);
    await expect(checkLiveOffer({ ...product, price: rub(-1) }, req, s)).rejects.toThrow();
    await expect(checkLiveOffer(product, req, s, { timeoutMs: 0 })).rejects.toThrow(RangeError);
    await expect(checkLiveOffer(product, req, s, { timeoutMs: 2 ** 31 })).rejects.toThrow(RangeError);
    await expect(checkLiveOffer(product, req, s, { maxAgeMs: -1 })).rejects.toThrow(RangeError);
    await expect(checkLiveOffer(product, req, {} as LiveOfferSource)).rejects.toThrow(TypeError);
    expect(s.calls).toHaveLength(0);
  });
});

describe("compareLiveOffer и границы пакета", () => {
  it("сравнение без сети — те же коды", () => {
    expect(compareLiveOffer(product, live(), req, { now })).toEqual({ ok: true, offer: live() });
    expect(compareLiveOffer(product, live({ price: rub(1) }), req, { now })).toEqual({ ok: false, codes: ["LIVE_PRICE_DOWN"], offer: live({ price: rub(1) }) });
    expect(compareLiveOffer(product, { sku: "tartine" }, req, { now })).toEqual({ ok: false, codes: ["LIVE_INVALID"], offer: null });
    expect(() => compareLiveOffer(product, live(), req, { now: () => NaN })).toThrow(TypeError);
  });

  it("основной вход не реэкспортирует живую проверку", () => {
    for (const name of ["checkLiveOffer", "compareLiveOffer"]) expect(core).not.toHaveProperty(name);
  });
});
