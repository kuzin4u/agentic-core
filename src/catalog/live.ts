// Живая проверка цены и наличия перед заказом (К15, К8 п. 5): заказ по данным фида без неё запрещён.
// Транспорт к продавцу — у потребителя через `LiveOfferSource`; в ядре сети нет.
import { money, type Money } from "../money.js";
import { isIsoDateTime } from "./date.js";
import type { CatalogAvailability, CatalogProduct } from "./types.js";

/** Запрос живого предложения. `quantity` — целое ≥ 1; `region` — код из `CatalogShop.deliveryRegions`, передаётся источнику как есть. */
export interface LiveOfferRequest { sku: string; quantity: number; region?: string; }

/** Ответ продавца. `checkedAt` — время ответа у продавца, ISO 8601 с часовым поясом. */
export interface LiveOffer { sku: string; price: Money; availability: CatalogAvailability; checkedAt: string; }

/** Порт к продавцу: API продавца, ПАО, площадка — у потребителя. По `signal` запрос прерывается при истечении `timeoutMs`. */
export interface LiveOfferSource { fetch(req: LiveOfferRequest, signal: AbortSignal): Promise<LiveOffer>; }

/** Коды без текста; каждый запрещает заказ. */
export type LiveCheckCode =
  | "LIVE_UNAVAILABLE"  // источник бросил, отклонил или не ответил за timeoutMs; неожиданное исключение проверки
  | "LIVE_INVALID"      // ответ не по форме: не тот sku, сумма не по К9, наличие не по модели, дата без пояса
  | "LIVE_STALE"        // ответ старше maxAgeMs или из будущего больше чем на clockSkewMs
  | "LIVE_CURRENCY"     // валюта ответа не та, что в каталоге
  | "LIVE_PRICE_UP"     // цена у продавца выше каталога (допуска нет, К15 п. 4)
  | "LIVE_PRICE_DOWN"   // цена у продавца ниже каталога
  | "LIVE_OUT_OF_STOCK" // нет в наличии
  | "LIVE_QUANTITY";    // продавец сообщил количество, и оно меньше запрошенного

export interface LiveCheckOptions {
  /** По умолчанию 5000 мс. */
  timeoutMs?: number;
  /** По умолчанию 60 000 мс. */
  maxAgeMs?: number;
  /** По умолчанию 30 000 мс. */
  clockSkewMs?: number;
  /** Часы, мс от эпохи; по умолчанию `Date.now`. */
  now?: () => number;
}

/** `offer` — копия ответа; `null`, если ответа нет или он не по форме. */
export type LiveCheckResult =
  | { ok: true; offer: LiveOffer }
  | { ok: false; codes: LiveCheckCode[]; offer: LiveOffer | null };

interface Opts { timeoutMs: number; maxAgeMs: number; clockSkewMs: number; now: () => number; }

/** Проверка перед заказом: один вызов источника, без повторов. На поведении источника не бросает:
 *  исключение (отклонённое обещание) — только на ошибке вызова (`req`, `options`, товар не того `sku`). */
export async function checkLiveOffer(product: CatalogProduct, req: LiveOfferRequest, source: LiveOfferSource, options: LiveCheckOptions = {}): Promise<LiveCheckResult> {
  const o = opts(options);
  const r = request(product, req);
  if (typeof source?.fetch !== "function") throw new TypeError("source");
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answer: unknown;
  try {
    answer = await Promise.race([
      Promise.resolve().then(() => source.fetch(r, ctl.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new Error("timeout")); }, o.timeoutMs); }),
    ]);
  } catch {
    return { ok: false, codes: ["LIVE_UNAVAILABLE"], offer: null };
  } finally {
    clearTimeout(timer);
  }
  try { return compare(product, answer, r, o); } catch { return { ok: false, codes: ["LIVE_UNAVAILABLE"], offer: null }; }
}

/** Сравнение без сети — для ответа, полученного другим путём. Бросает только на ошибке вызова. */
export function compareLiveOffer(product: CatalogProduct, offer: unknown, req: LiveOfferRequest, options: LiveCheckOptions = {}): LiveCheckResult {
  return compare(product, offer, request(product, req), opts(options));
}

function compare(product: CatalogProduct, answer: unknown, req: LiveOfferRequest, o: Opts): LiveCheckResult {
  const offer = snapshot(answer, req.sku);
  if (!offer) return { ok: false, codes: ["LIVE_INVALID"], offer: null };
  const now = o.now();
  if (!Number.isFinite(now)) throw new TypeError("now");
  const at = Date.parse(offer.checkedAt);
  if (now - at > o.maxAgeMs || at - now > o.clockSkewMs) return { ok: false, codes: ["LIVE_STALE"], offer };
  const codes: LiveCheckCode[] = [];
  if (offer.price.currency !== product.price.currency) codes.push("LIVE_CURRENCY");
  else if (offer.price.amount > product.price.amount) codes.push("LIVE_PRICE_UP");
  else if (offer.price.amount < product.price.amount) codes.push("LIVE_PRICE_DOWN");
  if (!offer.availability.inStock) codes.push("LIVE_OUT_OF_STOCK");
  const q = offer.availability.quantity;
  if (q !== undefined && q < req.quantity) codes.push("LIVE_QUANTITY");
  return codes.length === 0 ? { ok: true, offer } : { ok: false, codes, offer };
}

/** Копия ответа с однократным чтением полей; `null` — не по форме или поле не читается (геттер бросил). */
function snapshot(v: unknown, sku: string): LiveOffer | null {
  try {
    if (!isObj(v)) return null;
    const s = v.sku, p = v.price, a = v.availability, c = v.checkedAt;
    if (s !== sku || !isObj(p) || !isObj(a) || typeof c !== "string" || !isIsoDateTime(c)) return null;
    const price = money(p.amount as number, p.currency as string);
    const inStock = a.inStock, quantity = a.quantity;
    if (typeof inStock !== "boolean") return null;
    if (quantity !== undefined && (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 0)) return null;
    const availability: CatalogAvailability = quantity === undefined ? { inStock } : { inStock, quantity };
    return { sku, price, availability, checkedAt: c };
  } catch {
    return null;
  }
}

function request(product: CatalogProduct, req: LiveOfferRequest): LiveOfferRequest {
  if (!isObj(req) || typeof req.sku !== "string" || req.sku === "") throw new TypeError("req.sku");
  if (!Number.isSafeInteger(req.quantity) || req.quantity < 1) throw new RangeError("req.quantity");
  if (req.region !== undefined && (typeof req.region !== "string" || req.region === "")) throw new TypeError("req.region");
  if (!isObj(product) || product.sku !== req.sku) throw new TypeError("product.sku");
  money(product.price?.amount, product.price?.currency);
  return req.region === undefined ? { sku: req.sku, quantity: req.quantity } : { sku: req.sku, quantity: req.quantity, region: req.region };
}

function opts(o: LiveCheckOptions): Opts {
  const r = {
    timeoutMs: o.timeoutMs ?? 5000,
    maxAgeMs: o.maxAgeMs ?? 60_000,
    clockSkewMs: o.clockSkewMs ?? 30_000,
    now: o.now ?? Date.now,
  };
  if (!Number.isSafeInteger(r.timeoutMs) || r.timeoutMs < 1) throw new RangeError("timeoutMs");
  if (!Number.isSafeInteger(r.maxAgeMs) || r.maxAgeMs < 0) throw new RangeError("maxAgeMs");
  if (!Number.isSafeInteger(r.clockSkewMs) || r.clockSkewMs < 0) throw new RangeError("clockSkewMs");
  if (typeof r.now !== "function") throw new TypeError("now");
  return r;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
