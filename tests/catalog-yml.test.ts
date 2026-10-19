// Коннектор YML по К14: фид → каноническая модель К8; затем validate* и A5 — отдельным вызовом, как у потребителя.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkProductA5, checkShopA5, parseYml, validateProduct, validateShop, type CatalogShop } from "../src/catalog/index.js";
import { linearInWorker } from "./linear.js";

const FEED = readFileSync(new URL("./fixtures/massa-madre.yml", import.meta.url));
const profile = (): CatalogShop => ({
  id: "massa-madre", inn: "7705123452", mcc: "5462", paymentMethods: ["sbp", "card"], deliveryRegions: ["77"],
  returns: { days: 0, text: "Продовольственные товары надлежащего качества возврату не подлежат" },
});
const OPT = { exponent: 2, offset: "+03:00" };
const codes = (issues: { code: string; path: string }[]) => issues.map((i) => `${i.code} ${i.path}`);
const rub = (amount: number) => ({ amount, currency: "RUB" });

/** Фид из одного предложения: `offer` — содержимое, `shop` — что добавить в магазин. */
const feed = (offer: string, { shop = "", attrs = `id="x"`, date = "2026-10-17T07:00+03:00" } = {}) => `<yml_catalog date="${date}"><shop>
  <currencies><currency id="RUB" rate="1"/></currencies>
  <categories><category id="1">Хлеб</category></categories>${shop}
  <offers><offer ${attrs}>${offer}</offer></offers></shop></yml_catalog>`;
const BASE = `<name>Хлеб</name><price>100</price><currencyId>RUB</currencyId><categoryId>1</categoryId>`;

describe("коннектор YML: фид «Масса Мадре» (К14)", () => {
  const r = parseYml(FEED, profile(), OPT);

  it("4 позиции без ошибок перевода; магазин — профиль потребителя", () => {
    expect(r.issues).toEqual([]);
    expect(r.shop).toEqual(profile());
    expect(r.products.map((p) => [p.sku, p.title, p.category, p.price.amount, p.availability.inStock])).toEqual([
      ["tartine", "Тартин", "Хлеб / На закваске", 45_000, true],
      ["zavarnoy", "Заварной", "Хлеб / Заварной", 39_000, true],
      ["tartine-cheese", "Тартин сырный", "Хлеб / На закваске", 52_050, false],
      ["borodinsky", "Бородинский", "Хлеб / Заварной", 29_000, true],
    ]);
  });

  it("поля: RUR → RUB, дата с поясом из offset, вес, фото, количество, выпечка без штрихкода и бренда", () => {
    const [tartine, , cheese, borodinsky] = r.products;
    expect(tartine).toEqual({
      sku: "tartine", gtin: null, brand: null, model: null, attributes: { "вес": "750 г" },
      title: "Тартин", category: "Хлеб / На закваске", price: rub(45_000),
      availability: { inStock: true, quantity: 12 },
      delivery: [
        { method: "DELIVERY", minDays: 1, maxDays: 1, cost: rub(30_000) },
        { method: "PICKUP", minDays: 0, maxDays: 0, cost: rub(0) },
      ],
      updatedAt: "2026-10-17T07:00+03:00",
      description: "<p>Пшеничный хлеб на закваске, 24 часа брожения. Цена 450 ₽.</p>",
      images: ["https://example.invalid/tartine.jpg"],
    });
    expect(cheese!.description).toBe("Тартин с сыром & тмином");
    // delivery=false — только самовывоз; варианты предложения заменяют варианты магазина
    expect(cheese!.delivery.map((d) => d.method)).toEqual(["PICKUP"]);
    expect(borodinsky!.delivery).toEqual([
      { method: "DELIVERY", minDays: 1, maxDays: 2, cost: rub(0) },
      { method: "PICKUP", minDays: 0, maxDays: 0, cost: rub(0) },
    ]);
  });

  it("результат проходит validateShop, validateProduct и A5 без замечаний", () => {
    expect(validateShop(r.shop)).toEqual([]);
    for (const p of r.products) {
      expect(validateProduct(p, r.shop!), p.sku).toEqual([]);
      expect(checkProductA5(p, 2), p.sku).toEqual([]);
    }
    expect(checkShopA5(r.shop!)).toEqual([]);
  });

  it("A5 — отдельным вызовом: цена в описании не та — коннектор переводит, сигнал даёт checkProductA5", () => {
    const x = parseYml(feed(BASE + `<description>Всего 90 ₽</description>`), profile(), OPT);
    expect(x.issues).toEqual([]);
    expect(checkProductA5(x.products[0]!, 2)).toEqual([{ code: "A5_PRICE_MISMATCH", path: "$.description", found: 9_000 }]);
  });

  it("windows-1251 по объявлению", () => {
    const cp1251 = (s: string) => Buffer.from([...s].map((ch) => {
      const c = ch.codePointAt(0)!;
      if (c < 0x80) return c;
      if (c >= 0x410 && c <= 0x44f) return c - 0x350;
      throw new Error(ch);
    }));
    const x = parseYml(cp1251(`<?xml version="1.0" encoding="windows-1251"?>` + feed(BASE.replace("Хлеб", "Бородинский"))), profile(), OPT);
    expect(x.products[0]!.title).toBe("Бородинский");
  });
});

describe("коннектор YML: ошибки перевода — коды и путь, без исключений", () => {
  const issues = (xml: string, opt = OPT) => codes(parseYml(xml, profile(), opt).issues);
  const AT = "/yml_catalog/shop/offers/offer[1]";

  it("цена по К9: без округления; знак, разряды, экспонента — YML_PRICE", () => {
    for (const bad of ["100.555", "-1", "1 000", "1e3", "", "1.", "99999999999999999999"]) {
      expect(issues(feed(BASE.replace("<price>100</price>", `<price>${bad}</price>`))), bad).toEqual([`YML_PRICE ${AT}/price`]);
    }
    expect(issues(feed(BASE.replace("<price>100</price>", "<price>100.50</price>")), { exponent: 0, offset: "+03:00" })).toEqual([`YML_PRICE ${AT}/price`]);
    expect(parseYml(feed(BASE.replace("100", "7")), profile(), { exponent: 0 }).products[0]!.price).toEqual(rub(7));
    expect(issues(feed(BASE.replace("<price>100</price>", "")))).toEqual([`REQUIRED ${AT}/price`]);
  });

  it("дата: без пояса и без offset — YML_DATE, товаров нет; «+0300» и «Z» понимаются", () => {
    const x = parseYml(feed(BASE, { date: "2026-10-17 07:00" }), profile(), { exponent: 2 });
    expect(codes(x.issues)).toEqual(["YML_DATE /yml_catalog/@date"]);
    expect(x.products).toEqual([]);
    expect(parseYml(feed(BASE, { date: "2026-10-17T07:00:00+0300" }), profile(), OPT).products[0]!.updatedAt).toBe("2026-10-17T07:00:00+03:00");
    expect(parseYml(feed(BASE, { date: "2026-10-17T04:00Z" }), profile(), OPT).products[0]!.updatedAt).toBe("2026-10-17T04:00Z");
    expect(issues(feed(BASE, { date: "17.10.2026" }))).toEqual(["YML_DATE /yml_catalog/@date"]);
  });

  it("дата по календарю (К20 п. 1): 30 февраля, 24:00, пояс +15:00 — YML_DATE; неверный offset — тоже", () => {
    for (const date of ["2026-02-30 09:00", "2026-10-17 24:00", "2026-10-17T09:00+1500", "2026-10-17 09:00:60"]) {
      expect(issues(feed(BASE, { date })), date).toEqual(["YML_DATE /yml_catalog/@date"]);
    }
    const x = parseYml(feed(BASE, { date: "2026-10-17 07:00" }), profile(), { exponent: 2, offset: "+15:00" });
    expect(codes(x.issues)).toEqual(["YML_DATE /yml_catalog/@date"]);
    expect(parseYml(feed(BASE, { date: "2024-02-29 07:00" }), profile(), OPT).products[0]!.updatedAt).toBe("2024-02-29T07:00+03:00");
  });

  it("валюта, категория, количество, id, название", () => {
    expect(issues(feed(BASE.replace("RUB</currencyId>", "USD</currencyId>")))).toEqual([`YML_CURRENCY ${AT}/currencyId`]);
    expect(issues(feed(BASE.replace("<categoryId>1</categoryId>", "<categoryId>9</categoryId>")))).toEqual([`YML_CATEGORY ${AT}/categoryId`]);
    expect(issues(feed(BASE, { attrs: "" }))).toEqual([`REQUIRED ${AT}/@id`]);
    expect(issues(feed(BASE.replace("<name>Хлеб</name>", "")))).toEqual([`REQUIRED ${AT}/name`]);
    expect(issues(feed(BASE + "<count>-1</count>"))).toEqual([`YML_NUMBER ${AT}/count`]);
    const cycle = `<categories><category id="2" parentId="3">А</category><category id="3" parentId="2">Б</category></categories>`;
    expect(issues(feed(BASE.replace("<categoryId>1</categoryId>", "<categoryId>2</categoryId>"), { shop: "" }).replace("<categories>", cycle + "<categories>")))
      .toEqual([`YML_CATEGORY ${AT}/categoryId`]);
  });

  it("варианты доставки: days и cost с ошибкой", () => {
    expect(issues(feed(BASE + `<delivery-options><option cost="0" days="завтра"/></delivery-options>`))).toEqual([`YML_NUMBER ${AT}/delivery-options/option[1]/@days`]);
    expect(issues(feed(BASE + `<delivery-options><option cost="1.234" days="1"/></delivery-options>`))).toEqual([`YML_PRICE ${AT}/delivery-options/option[1]/@cost`]);
    // ошибка варианта магазина — замечание, предложение переводится без этого варианта
    const x = parseYml(feed(BASE, { shop: `<delivery-options><option days="1"/></delivery-options>` }), profile(), OPT);
    expect(codes(x.issues)).toEqual(["REQUIRED /yml_catalog/shop/delivery-options/option[1]/@cost"]);
    expect(x.products[0]!.delivery).toEqual([]);
  });

  it("vendor.model: название из typePrefix, vendor, model; barcode → gtin", () => {
    const x = parseYml(feed(`<typePrefix>Хлебопечка</typePrefix><vendor>Бренд</vendor><model>М-1</model><barcode>4006381333931</barcode>
      <price>100</price><currencyId>RUB</currencyId><categoryId>1</categoryId>`, { attrs: `id="x" type="vendor.model"` }), profile(), OPT);
    expect(x.products[0]).toMatchObject({ title: "Хлебопечка Бренд М-1", brand: "Бренд", model: "М-1", gtin: "4006381333931" });
  });

  it("не YML и ошибка XML: shop — null, путь @смещение; DOCTYPE с [ — XML_DOCTYPE", () => {
    expect(parseYml("<rss/>", profile(), OPT)).toEqual({ shop: null, products: [], issues: [{ code: "YML_STRUCTURE", path: "/rss" }] });
    expect(parseYml(`<!DOCTYPE y [<!ENTITY x SYSTEM "file:///etc/passwd">]><yml_catalog/>`, profile(), OPT))
      .toEqual({ shop: null, products: [], issues: [{ code: "XML_DOCTYPE", path: "@12" }] });
  });

  it("нулевой байт в описании или атрибуте — XML_SYNTAX, фид не переводится (ревью из чата 17.10, П1.4)", () => {
    const desc = feed(BASE + "<description>Хлеб\u0000</description>");
    expect(parseYml(desc, profile(), OPT)).toEqual({ shop: null, products: [], issues: [{ code: "XML_SYNTAX", path: `@${desc.indexOf("\u0000")}` }] });
    expect(parseYml(feed(BASE, { attrs: `id="x\u0000"` }), profile(), OPT).issues[0]!.code).toBe("XML_SYNTAX");
  });

  it("ошибка вызова — RangeError", () => {
    expect(() => parseYml(FEED, profile(), { exponent: -1 })).toThrow(RangeError);
    expect(() => parseYml(FEED, profile(), { exponent: 2, offset: "MSK" })).toThrow(RangeError);
  });

  it("линейное время: цепочка из 20 000 категорий и 20 000 предложений в самой глубокой (worker)", async () => {
    expect(await linearInWorker("yml", 20_000, 5000)).toEqual([20_000, 0]);
  }, 20_000); // бюджет разбора — 5 с процессора (П2.1, ≈ 0,75 с); 20 с — запас по часам под нагрузкой (П1.4)
});
