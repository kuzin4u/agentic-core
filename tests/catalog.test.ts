// catalog по К8 п. 1: каноническая модель магазина и товара, валидатор с кодами и путём поля; суммы — Money (К9).
import { describe, it, expect } from "vitest";
import * as core from "../src/index.js";
import { validateShop, validateProduct, isInn, isGtin, type CatalogShop, type CatalogProduct } from "../src/catalog/index.js";

const shop = (): CatalogShop => ({
  id: "shop-1", inn: "7707083893", mcc: "5462", paymentMethods: ["sbp", "card"], deliveryRegions: ["77", "50"],
  returns: { days: 14, text: "Возврат в течение 14 дней" },
});
const product = (): CatalogProduct => ({
  sku: "B-500", gtin: "4006381333931", brand: "Бренд", model: "М-1", attributes: { "вес": "500 г" },
  title: "Хлеб пшеничный", category: "Хлеб", price: { amount: 25_000, currency: "RUB" },
  availability: { inStock: true, quantity: 3 },
  delivery: [{ method: "DELIVERY", region: "77", minDays: 0, maxDays: 1, cost: { amount: 0, currency: "RUB" } }],
  updatedAt: "2026-10-17T09:00:00+03:00",
});
const codes = (issues: { code: string; path: string }[]) => issues.map((i) => `${i.code} ${i.path}`);

describe("catalog: магазин", () => {
  it("полный магазин и с желательными полями — без нарушений", () => {
    expect(validateShop(shop())).toEqual([]);
    expect(validateShop({ ...shop(), readiness: { zone: "A", mark: true }, fulfillmentRating: 0.97 })).toEqual([]);
  });

  it("нет обязательных полей — REQUIRED с путём", () => {
    expect(codes(validateShop({}))).toEqual([
      "REQUIRED $.id", "REQUIRED $.inn", "REQUIRED $.mcc", "REQUIRED $.paymentMethods", "REQUIRED $.deliveryRegions", "REQUIRED $.returns",
    ]);
    expect(codes(validateShop(null))).toEqual(["BAD_TYPE $"]);
    expect(codes(validateShop({ ...shop(), returns: {} }))).toEqual(["REQUIRED $.returns.days", "REQUIRED $.returns.text"]);
  });

  it("возврат: days = 0 — нормальное значение (продовольственные товары), отрицательное — BAD_RANGE", () => {
    expect(validateShop({ ...shop(), returns: { days: 0, text: "Продовольственные товары надлежащего качества возврату не подлежат" } })).toEqual([]);
    expect(codes(validateShop({ ...shop(), returns: { days: -1, text: "—" } }))).toEqual(["BAD_RANGE $.returns.days"]);
  });

  it("ИНН, MCC, рейтинг, списки", () => {
    expect(codes(validateShop({ ...shop(), inn: "7707083894" }))).toEqual(["BAD_INN $.inn"]);
    expect(codes(validateShop({ ...shop(), mcc: "546" }))).toEqual(["BAD_MCC $.mcc"]);
    expect(codes(validateShop({ ...shop(), fulfillmentRating: 1.5 }))).toEqual(["BAD_RANGE $.fulfillmentRating"]);
    expect(codes(validateShop({ ...shop(), paymentMethods: ["sbp", ""] }))).toEqual(["BAD_TYPE $.paymentMethods[1]"]);
    expect(codes(validateShop({ ...shop(), id: "" }))).toEqual(["BAD_TYPE $.id"]);
    expect(codes(validateShop({ ...shop(), readiness: { zone: "A", mark: "да" } }))).toEqual(["BAD_TYPE $.readiness.mark"]);
  });

  it("isInn: 10 и 12 цифр с контрольными цифрами", () => {
    expect(isInn("7707083893")).toBe(true);
    expect(isInn("500100732259")).toBe(true);
    expect(isInn("500100732258")).toBe(false);
    expect(isInn("770708389")).toBe(false);
    expect(isInn("77070838９3")).toBe(false);
  });
});

describe("catalog: товар", () => {
  it("полный товар — без нарушений; gtin, brand, model = null допустимы, отсутствие — нет", () => {
    expect(validateProduct(product())).toEqual([]);
    expect(validateProduct({ ...product(), gtin: null, brand: null, model: null })).toEqual([]);
    const { gtin, brand, model, ...rest } = product();
    expect(codes(validateProduct(rest))).toEqual(["REQUIRED $.gtin", "REQUIRED $.brand", "REQUIRED $.model"]);
  });

  it("сумма — проверкой money (К9): дробная, отрицательная, выше MAX_SAFE_INTEGER, валюта", () => {
    for (const amount of [250.5, -1, Number.MAX_SAFE_INTEGER + 1, "25000"]) {
      expect(codes(validateProduct({ ...product(), price: { amount, currency: "RUB" } })), String(amount)).toEqual(["BAD_AMOUNT $.price.amount"]);
    }
    expect(codes(validateProduct({ ...product(), price: { amount: 1, currency: "rub" } }))).toEqual(["BAD_CURRENCY $.price.currency"]);
    expect(codes(validateProduct({ ...product(), price: 25_000 }))).toEqual(["BAD_TYPE $.price"]);
  });

  it("GTIN: длина и контрольная цифра", () => {
    expect(codes(validateProduct({ ...product(), gtin: "4006381333932" }))).toEqual(["BAD_GTIN $.gtin"]);
    for (const g of ["96385074", "036000291452", "4006381333931", "10614141000415"]) expect(isGtin(g), g).toBe(true);
    for (const g of ["4006381333", "40063813339310", "abcdefghijklm"]) expect(isGtin(g), g).toBe(false);
  });

  it("доставка: хотя бы один вариант, minDays ≤ maxDays, стоимость — Money, регион — из магазина", () => {
    expect(codes(validateProduct({ ...product(), delivery: [] }))).toEqual(["REQUIRED $.delivery[0]"]);
    const d = product().delivery[0]!;
    expect(codes(validateProduct({ ...product(), delivery: [{ ...d, minDays: 3, maxDays: 1 }] }))).toEqual(["BAD_RANGE $.delivery[0].maxDays"]);
    expect(codes(validateProduct({ ...product(), delivery: [d, { ...d, cost: { amount: 1, currency: "" } }] }))).toEqual(["BAD_CURRENCY $.delivery[1].cost.currency"]);
    expect(codes(validateProduct({ ...product(), delivery: [{ ...d, region: "99" }] }, shop()))).toEqual(["UNKNOWN_REGION $.delivery[0].region"]);
    expect(validateProduct({ ...product(), delivery: [{ ...d, region: "99" }] })).toEqual([]);
    const { region, ...anyRegion } = d;
    expect(validateProduct({ ...product(), delivery: [anyRegion] }, shop())).toEqual([]);
  });

  it("способ получения: DELIVERY или PICKUP; самовывоз — за 0 и может быть единственным вариантом", () => {
    const pickup = { method: "PICKUP", minDays: 0, maxDays: 0, cost: { amount: 0, currency: "RUB" } };
    expect(validateProduct({ ...product(), delivery: [pickup] }, shop())).toEqual([]);
    expect(codes(validateProduct({ ...product(), delivery: [{ ...pickup, cost: { amount: 100, currency: "RUB" } }] }))).toEqual(["BAD_RANGE $.delivery[0].cost.amount"]);
    expect(codes(validateProduct({ ...product(), delivery: [{ ...pickup, method: "COURIER" }] }))).toEqual(["BAD_METHOD $.delivery[0].method"]);
    const { method, ...noMethod } = pickup;
    expect(codes(validateProduct({ ...product(), delivery: [noMethod] }))).toEqual(["REQUIRED $.delivery[0].method"]);
    expect(codes(validateProduct({ ...product(), delivery: [{ ...pickup, method: "PICKUP", cost: { amount: 1.5, currency: "RUB" } }] }))).toEqual(["BAD_AMOUNT $.delivery[0].cost.amount"]);
  });

  it("атрибуты, наличие, дата обновления, желательные поля", () => {
    expect(codes(validateProduct({ ...product(), attributes: { "вес": 500 } }))).toEqual(["BAD_TYPE $.attributes.вес"]);
    expect(codes(validateProduct({ ...product(), availability: { inStock: true, quantity: -1 } }))).toEqual(["BAD_RANGE $.availability.quantity"]);
    expect(codes(validateProduct({ ...product(), availability: {} }))).toEqual(["REQUIRED $.availability.inStock"]);
    for (const u of ["2026-10-17", "2026-10-17T09:00:00", "вчера", "2026-13-45T09:00:00Z"]) {
      expect(codes(validateProduct({ ...product(), updatedAt: u })), u).toEqual(["BAD_DATE $.updatedAt"]);
    }
    expect(validateProduct({ ...product(), updatedAt: "2026-10-17T06:00:00.123Z", description: "Описание", images: ["https://x/1.jpg"] })).toEqual([]);
    expect(codes(validateProduct({ ...product(), images: [""] }))).toEqual(["BAD_TYPE $.images[0]"]);
  });

  it("неизвестные поля допускаются; на данных продавца исключений нет", () => {
    expect(validateProduct({ ...product(), vendorCode: "X" })).toEqual([]);
    for (const v of [undefined, 1, "x", [], { price: { amount: 1n, currency: "RUB" } }]) expect(() => validateProduct(v)).not.toThrow();
  });
});

describe("catalog: подмодуль", () => {
  it("основной вход не раскрывает /catalog (К8 п. 6)", () => {
    for (const name of Object.keys(core)) expect(name).not.toMatch(/catalog|shop|product|gtin|inn$/i);
  });
});
