import type { CatalogDelivery, CatalogDeliveryMethod, CatalogProduct, CatalogShop } from "./types.js";
import type { CatalogIssue } from "./validate.js";
import { isIsoDateTime } from "./date.js";
import { childNamed, childrenNamed, parseXml, textOf, type XmlElement, type XmlLimits } from "./xml.js";

/** Коннектор YML (К14): фид продавца → каноническая модель К8. Переводит формат, но не судит продавца:
 *  `validateShop`, `validateProduct` и A5 — отдельным вызовом потребителя. */

/** `exponent` — знаков после запятой у валюты цены (RUB — 2), таблицы в ядре нет (К9); `offset` — часовой пояс для
 *  `yml_catalog@date` без него (`+03:00`); `limits` — пределы разборщика XML. */
export interface YmlOptions { exponent: number; offset?: string; limits?: XmlLimits; }

/** `shop` — профиль потребителя как есть (ИНН, MCC, оплаты, регионы и возврата в YML нет); `null` — фид не разобран.
 *  Предложение с ошибкой перевода в `products` не попадает, его ошибки — в `issues`. */
export interface YmlResult { shop: CatalogShop | null; products: CatalogProduct[]; issues: CatalogIssue[]; }

interface Option { minDays: number; maxDays: number; cost: string; at: string; }
interface Category { name: string; parent: string | undefined; }

/** Фид YML → магазин и товары. Ошибка XML — `{ shop: null, products: [], issues: [{ code: "XML_…", path: "@смещение" }] }`.
 *  Исключение — только на ошибке вызова: неверный `exponent`, `offset` или пределы. */
export function parseYml(input: string | Uint8Array, profile: CatalogShop, options: YmlOptions): YmlResult {
  const { exponent, offset } = options;
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 18) throw new RangeError("exponent");
  if (offset !== undefined && !/^[+-]\d{2}:\d{2}$/.test(offset)) throw new RangeError("offset");
  const xml = parseXml(input, options.limits);
  if (!xml.ok) return { shop: null, products: [], issues: [{ code: xml.code, path: `@${xml.offset}` }] };

  const issues: CatalogIssue[] = [], products: CatalogProduct[] = [];
  const root = xml.root, shopEl = childNamed(root, "shop"), offersEl = shopEl && childNamed(shopEl, "offers");
  if (root.name !== "yml_catalog" || !shopEl || !offersEl) {
    return { shop: null, products, issues: [{ code: "YML_STRUCTURE", path: "/" + root.name }] };
  }
  const SHOP = "/yml_catalog/shop";
  const updatedAt = date(root.attrs.date, offset);
  if (updatedAt === undefined) issues.push({ code: "YML_DATE", path: "/yml_catalog/@date" });

  const currencies = new Set(childrenNamed(childNamed(shopEl, "currencies") ?? EMPTY, "currency").map((c) => currency(c.attrs.id ?? "")));
  const categories = new Map<string, Category>();
  for (const c of childrenNamed(childNamed(shopEl, "categories") ?? EMPTY, "category")) {
    if (c.attrs.id !== undefined) categories.set(c.attrs.id, { name: textOf(c).trim(), parent: c.attrs.parentId });
  }
  const paths = new Map<string, string | null>();
  const shopOptions = {
    DELIVERY: options_(shopEl, "delivery-options", SHOP, issues),
    PICKUP: options_(shopEl, "pickup-options", SHOP, issues),
  };

  childrenNamed(offersEl, "offer").forEach((o, i) => {
    const at = `${SHOP}/offers/offer[${i + 1}]`, own: CatalogIssue[] = [];
    const field = (name: string) => { const el = childNamed(o, name); return el && textOf(el).trim(); };
    const sku = o.attrs.id;
    if (!sku) own.push({ code: "REQUIRED", path: `${at}/@id` });

    const vendor = field("vendor") || null, model = field("model") || null;
    const title = o.attrs.type === "vendor.model"
      ? [field("typePrefix"), vendor, model].filter(Boolean).join(" ")
      : field("name") ?? "";
    if (!title) own.push({ code: "REQUIRED", path: `${at}/name` });

    const cur = currency(field("currencyId") ?? "");
    if (!cur || (currencies.size > 0 && !currencies.has(cur))) own.push({ code: "YML_CURRENCY", path: `${at}/currencyId` });
    const priceText = field("price");
    const amount = priceText === undefined ? undefined : minorUnits(priceText, exponent);
    if (priceText === undefined) own.push({ code: "REQUIRED", path: `${at}/price` });
    else if (amount === undefined) own.push({ code: "YML_PRICE", path: `${at}/price` });

    const category = categoryPath(field("categoryId"), categories, paths);
    if (category === undefined) own.push({ code: "YML_CATEGORY", path: `${at}/categoryId` });

    const countText = field("count");
    const quantity = countText === undefined ? undefined : /^\d{1,15}$/.test(countText) ? Number(countText) : NaN;
    if (Number.isNaN(quantity)) own.push({ code: "YML_NUMBER", path: `${at}/count` });

    const delivery: CatalogDelivery[] = [];
    for (const method of ["DELIVERY", "PICKUP"] as const) {
      if (field(method === "DELIVERY" ? "delivery" : "pickup") === "false") continue;
      const opts = childNamed(o, OPTIONS[method]) ? options_(o, OPTIONS[method], at, own) : shopOptions[method];
      for (const opt of opts) {
        const cost = minorUnits(opt.cost, exponent);
        if (cost === undefined) own.push({ code: "YML_PRICE", path: `${opt.at}/@cost` });
        else delivery.push(variant(method, opt, cost, cur));
      }
    }
    if (own.length || updatedAt === undefined) { issues.push(...own); return; }

    const attributes = Object.create(null) as Record<string, string>;
    for (const p of childrenNamed(o, "param")) {
      const name = p.attrs.name?.trim(), value = textOf(p).trim(), unit = p.attrs.unit?.trim();
      if (name && value && !(name in attributes)) attributes[name] = unit ? `${value} ${unit}` : value;
    }
    const barcode = childNamed(o, "barcode");
    const product: CatalogProduct = {
      sku: sku!, gtin: (barcode && textOf(barcode).trim()) || null, brand: vendor, model, attributes,
      title, category: category!, price: { amount: amount!, currency: cur },
      availability: quantity === undefined ? { inStock: o.attrs.available !== "false" } : { inStock: o.attrs.available !== "false", quantity },
      delivery, updatedAt,
    };
    const description = field("description");
    if (description) product.description = description;
    const images = childrenNamed(o, "picture").map((p) => textOf(p).trim()).filter(Boolean);
    if (images.length) product.images = images;
    products.push(product);
  });
  return { shop: { ...profile }, products, issues };
}

const EMPTY: XmlElement = { name: "", attrs: {}, children: [] };
const OPTIONS = { DELIVERY: "delivery-options", PICKUP: "pickup-options" } as const;

/** `RUR` — прежний код рубля в YML. */
function currency(id: string): string { const c = id.trim(); return c === "RUR" ? "RUB" : c; }

/** Варианты `option` (`cost`, `days`): «2» → 2…2, «1-3» → 1…3. Ошибки — в `issues`, ошибочный вариант пропускается. */
function options_(parent: XmlElement, name: string, base: string, issues: CatalogIssue[]): Option[] {
  const el = childNamed(parent, name);
  if (!el) return [];
  const out: Option[] = [];
  childrenNamed(el, "option").forEach((o, i) => {
    const at = `${base}/${name}/option[${i + 1}]`;
    const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec((o.attrs.days ?? "").trim());
    if (!m) { issues.push({ code: "YML_NUMBER", path: `${at}/@days` }); return; }
    const minDays = Number(m[1]), maxDays = Number(m[2] ?? m[1]);
    if (o.attrs.cost === undefined) { issues.push({ code: "REQUIRED", path: `${at}/@cost` }); return; }
    out.push({ minDays, maxDays, cost: o.attrs.cost, at });
  });
  return out;
}

/** Стоимость доставки — в валюте цены предложения: курс `rate` коннектор не читает (К14 п. 1). */
function variant(method: CatalogDeliveryMethod, o: Option, cost: number, currency: string): CatalogDelivery {
  return { method, minDays: o.minDays, maxDays: o.maxDays, cost: { amount: cost, currency } };
}

/** «250», «250.50», «250,50» → минимальные единицы (К9). Знаков больше `exponent`, знак, разряды, экспонента — `undefined`. */
function minorUnits(text: string, exponent: number): number | undefined {
  const m = /^(\d{1,20})(?:[.,](\d{1,20}))?$/.exec(text.trim());
  if (!m) return undefined;
  const frac = m[2] ?? "";
  if (frac.length > exponent) return undefined;
  const v = BigInt(m[1]!) * 10n ** BigInt(exponent) + BigInt(frac.padEnd(exponent, "0") || "0");
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : undefined;
}

/** Путь категории от корня через « / »; нет категории, разрыв или цикл `parentId` — `null`. Пути запоминаются в `cache`:
 *  каждая категория проходится один раз, иначе длинная цепочка на многих предложениях дала бы квадратичное время. */
function categoryPath(id: string | undefined, categories: Map<string, Category>, cache: Map<string, string | null>): string | undefined {
  if (id === undefined) return undefined;
  const chain: string[] = [], seen = new Set<string>();
  let cur: string | undefined = id, base: string | null | undefined = "";
  while (cur !== undefined) {
    if (cache.has(cur)) { base = cache.get(cur); break; }
    const c = categories.get(cur);
    if (!c || !c.name || seen.has(cur)) { base = null; break; }
    seen.add(cur); chain.push(cur); cur = c.parent;
  }
  for (let k = chain.length - 1; k >= 0; k--) {
    const c = chain[k]!, name = categories.get(c)!.name;
    base = base === null || base === undefined ? null : base ? `${base} / ${name}` : name;
    cache.set(c, base);
  }
  return cache.get(id) ?? undefined;
}

/** `yml_catalog@date` → ISO 8601 с часовым поясом: «2026-10-17 09:00» и «…T09:00+0300» понимаются; без пояса — `offset`.
 *  Компоненты и пояс (свой или `offset`) — по календарю (К20 п. 1), иначе `undefined` → `YML_DATE`. */
function date(text: string | undefined, offset: string | undefined): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:?\d{2})?$/.exec((text ?? "").trim());
  if (!m) return undefined;
  const tz = m[3] === undefined ? offset : m[3] === "Z" ? "Z" : `${m[3].slice(0, 3)}:${m[3].slice(-2)}`;
  const iso = tz === undefined ? undefined : `${m[1]}T${m[2]}${tz}`;
  return iso !== undefined && isIsoDateTime(iso) ? iso : undefined;
}
