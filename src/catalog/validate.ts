import { MoneyError, money } from "../money.js";
import type { CatalogShop } from "./types.js";

/** Нарушение модели: код и путь поля (`$.price.amount`). Текстов для человека в ядре нет — их даёт потребитель по коду. */
export interface CatalogIssue { code: CatalogIssueCode; path: string; }

export type CatalogIssueCode =
  | "REQUIRED"        // поля нет
  | "BAD_TYPE"        // не тот тип или пустая строка
  | "BAD_AMOUNT"      // сумма не целое ≥ 0 в пределах Number.isSafeInteger (К9)
  | "BAD_CURRENCY"    // код валюты не ISO 4217 и не код актива (К9)
  | "BAD_INN"         // не 10 или 12 цифр либо неверная контрольная цифра
  | "BAD_MCC"         // не 4 цифры
  | "BAD_GTIN"        // не 8, 12, 13 или 14 цифр либо неверная контрольная цифра
  | "BAD_DATE"        // не ISO 8601 с часовым поясом
  | "BAD_RANGE"       // число вне допустимого: отрицательное, дробное, minDays > maxDays, рейтинг вне 0…1, самовывоз не за 0
  | "BAD_METHOD"      // способ получения не DELIVERY и не PICKUP
  | "UNKNOWN_REGION"; // регион доставки товара не входит в регионы магазина

type Obj = Record<string, unknown>;

/** Проверка магазина. Пустой список — магазин соответствует модели. Исключений на данных продавца нет. */
export function validateShop(value: unknown): CatalogIssue[] {
  const out: CatalogIssue[] = [];
  const s = object(value, "$", out);
  if (!s) return out;
  str(s, "id", "$", out);
  const inn = str(s, "inn", "$", out);
  if (inn !== undefined && !isInn(inn)) out.push({ code: "BAD_INN", path: "$.inn" });
  const mcc = str(s, "mcc", "$", out);
  if (mcc !== undefined && !/^\d{4}$/.test(mcc)) out.push({ code: "BAD_MCC", path: "$.mcc" });
  strList(s, "paymentMethods", "$", out);
  strList(s, "deliveryRegions", "$", out);
  const r = field(s, "returns", "$", out, true);
  if (r !== undefined) {
    const ro = object(r, "$.returns", out);
    if (ro) { count(ro, "days", "$.returns", out, true); str(ro, "text", "$.returns", out); }
  }
  const rd = field(s, "readiness", "$", out, false);
  if (rd !== undefined) {
    const o = object(rd, "$.readiness", out);
    if (o) {
      str(o, "zone", "$.readiness", out);
      if (field(o, "mark", "$.readiness", out, true) !== undefined && typeof o.mark !== "boolean") out.push({ code: "BAD_TYPE", path: "$.readiness.mark" });
    }
  }
  const fr = field(s, "fulfillmentRating", "$", out, false);
  if (fr !== undefined) {
    if (typeof fr !== "number" || !Number.isFinite(fr)) out.push({ code: "BAD_TYPE", path: "$.fulfillmentRating" });
    else if (fr < 0 || fr > 1) out.push({ code: "BAD_RANGE", path: "$.fulfillmentRating" });
  }
  return out;
}

/** Проверка товара. С `shop` — ещё и регионы доставки товара против регионов магазина. */
export function validateProduct(value: unknown, shop?: Pick<CatalogShop, "deliveryRegions">): CatalogIssue[] {
  const out: CatalogIssue[] = [];
  const p = object(value, "$", out);
  if (!p) return out;
  str(p, "sku", "$", out);
  const gtin = nullableStr(p, "gtin", out);
  if (typeof gtin === "string" && !isGtin(gtin)) out.push({ code: "BAD_GTIN", path: "$.gtin" });
  nullableStr(p, "brand", out);
  nullableStr(p, "model", out);
  const a = field(p, "attributes", "$", out, true);
  if (a !== undefined) {
    const ao = object(a, "$.attributes", out);
    if (ao) for (const [k, v] of Object.entries(ao)) if (typeof v !== "string" || v === "") out.push({ code: "BAD_TYPE", path: `$.attributes.${k}` });
  }
  str(p, "title", "$", out);
  str(p, "category", "$", out);
  moneyField(p, "price", "$", out);
  const av = field(p, "availability", "$", out, true);
  if (av !== undefined) {
    const o = object(av, "$.availability", out);
    if (o) {
      if (field(o, "inStock", "$.availability", out, true) !== undefined && typeof o.inStock !== "boolean") out.push({ code: "BAD_TYPE", path: "$.availability.inStock" });
      count(o, "quantity", "$.availability", out, false);
    }
  }
  const d = field(p, "delivery", "$", out, true);
  if (d !== undefined) {
    if (!Array.isArray(d)) out.push({ code: "BAD_TYPE", path: "$.delivery" });
    else if (d.length === 0) out.push({ code: "REQUIRED", path: "$.delivery[0]" });
    else d.forEach((x, i) => delivery(x, `$.delivery[${i}]`, out, shop));
  }
  const u = str(p, "updatedAt", "$", out);
  if (u !== undefined && !isIsoDateTime(u)) out.push({ code: "BAD_DATE", path: "$.updatedAt" });
  if (field(p, "description", "$", out, false) !== undefined) str(p, "description", "$", out);
  if (field(p, "images", "$", out, false) !== undefined) strList(p, "images", "$", out);
  return out;
}

function delivery(x: unknown, at: string, out: CatalogIssue[], shop?: Pick<CatalogShop, "deliveryRegions">): void {
  const o = object(x, at, out);
  if (!o) return;
  const method = field(o, "method", at, out, true);
  if (method !== undefined && method !== "DELIVERY" && method !== "PICKUP") out.push({ code: "BAD_METHOD", path: `${at}.method` });
  if (field(o, "region", at, out, false) !== undefined) {
    const r = str(o, "region", at, out);
    if (r !== undefined && shop && !shop.deliveryRegions.includes(r)) out.push({ code: "UNKNOWN_REGION", path: `${at}.region` });
  }
  const min = count(o, "minDays", at, out, true);
  const max = count(o, "maxDays", at, out, true);
  if (min !== undefined && max !== undefined && min > max) out.push({ code: "BAD_RANGE", path: `${at}.maxDays` });
  if (moneyField(o, "cost", at, out) && method === "PICKUP" && (o.cost as Obj).amount !== 0) out.push({ code: "BAD_RANGE", path: `${at}.cost.amount` });
}

function field(o: Obj, k: string, at: string, out: CatalogIssue[], required: boolean): unknown {
  if (o[k] === undefined && required) out.push({ code: "REQUIRED", path: `${at}.${k}` });
  return o[k];
}

function object(v: unknown, at: string, out: CatalogIssue[]): Obj | undefined {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Obj;
  out.push({ code: "BAD_TYPE", path: at });
  return undefined;
}

/** Непустая строка; `undefined` — поля нет или оно не строка (нарушение уже записано). */
function str(o: Obj, k: string, at: string, out: CatalogIssue[]): string | undefined {
  const v = field(o, k, at, out, true);
  if (v === undefined) return undefined;
  if (typeof v === "string" && v !== "") return v;
  out.push({ code: "BAD_TYPE", path: `${at}.${k}` });
  return undefined;
}

/** Поле обязательно в записи; `null` — значения у продавца нет. */
function nullableStr(o: Obj, k: string, out: CatalogIssue[]): string | null | undefined {
  return o[k] === null ? null : str(o, k, "$", out);
}

function strList(o: Obj, k: string, at: string, out: CatalogIssue[]): void {
  const v = field(o, k, at, out, true);
  if (v === undefined) return;
  if (!Array.isArray(v)) { out.push({ code: "BAD_TYPE", path: `${at}.${k}` }); return; }
  v.forEach((x, i) => { if (typeof x !== "string" || x === "") out.push({ code: "BAD_TYPE", path: `${at}.${k}[${i}]` }); });
}

/** Целое ≥ 0 в пределах Number.isSafeInteger. */
function count(o: Obj, k: string, at: string, out: CatalogIssue[], required: boolean): number | undefined {
  const v = field(o, k, at, out, required);
  if (v === undefined) return undefined;
  if (typeof v !== "number") { out.push({ code: "BAD_TYPE", path: `${at}.${k}` }); return undefined; }
  if (!Number.isSafeInteger(v) || v < 0) { out.push({ code: "BAD_RANGE", path: `${at}.${k}` }); return undefined; }
  return v;
}

/** Сумма — проверкой `money` (К9), без своей таблицы знаков. `true` — сумма верна. */
function moneyField(o: Obj, k: string, at: string, out: CatalogIssue[]): boolean {
  const v = field(o, k, at, out, true);
  if (v === undefined) return false;
  const m = object(v, `${at}.${k}`, out);
  if (!m) return false;
  try { money(m.amount as number, m.currency as string); return true; } catch (e) {
    if (!(e instanceof MoneyError)) throw e;
    out.push({ code: e.code === "BAD_CURRENCY" ? "BAD_CURRENCY" : "BAD_AMOUNT", path: `${at}.${k}.${e.code === "BAD_CURRENCY" ? "currency" : "amount"}` });
    return false;
  }
}

/** ИНН: 10 цифр (организация) или 12 (ИП) с контрольными цифрами по алгоритму ФНС. */
export function isInn(s: string): boolean {
  if (!/^\d{10}$|^\d{12}$/.test(s)) return false;
  const d = [...s].map(Number);
  const ctl = (w: number[]) => (w.reduce((a, x, i) => a + x * d[i]!, 0) % 11) % 10;
  if (d.length === 10) return ctl([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  return ctl([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && ctl([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
}

/** GTIN-8/12/13/14: контрольная цифра по GS1 (веса 3 и 1 справа налево). */
export function isGtin(s: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(s)) return false;
  const d = [...s].map(Number);
  const check = d.pop()!;
  const sum = d.reverse().reduce((a, x, i) => a + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function isIsoDateTime(s: string): boolean {
  return ISO_DATE_TIME.test(s) && Number.isFinite(Date.parse(s));
}
