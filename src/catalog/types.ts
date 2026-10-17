import type { Money } from "../money.js";

/** Каноническая модель каталога продавца (К8 п. 1). Агент читает каталоги только в ней; формат продавца переводит коннектор.
 *  Суммы — `Money` (К9): «цена в копейках» К8 — это минимальные единицы с кодом валюты. Неизвестные поля допускаются. */

/** Магазин. Обязательное — id, ИНН, MCC, способы оплаты, регионы доставки, условия возврата. */
export interface CatalogShop {
  id: string;
  /** ИНН продавца: 10 цифр — организация, 12 — индивидуальный предприниматель (сведения ЕГРИП открыты). */
  inn: string;
  /** Код категории продавца, 4 цифры. */
  mcc: string;
  /** Способы оплаты — коды потребителя (`sbp`, `card`); перечня в ядре нет. */
  paymentMethods: string[];
  /** Регионы доставки — коды потребителя; перечня в ядре нет. */
  deliveryRegions: string[];
  returns: CatalogReturns;
  /** Желательно: зона и знак готовности (A5). */
  readiness?: { zone: string; mark: boolean };
  /** Желательно: рейтинг исполнения, 0…1. */
  fulfillmentRating?: number;
}

/** Условия возврата: срок в полях и текст продавца, как его видит человек (по A5 они совпадают). */
export interface CatalogReturns {
  days: number;
  text: string;
}

/** Товар. Поля сопоставления — `gtin`, `brand`, `model`, `attributes`: по ним один товар находится у разных продавцов.
 *  `gtin`, `brand`, `model` обязательны в записи, `null` — у продавца их нет (выпечка без штрихкода), а не «забыли». */
export interface CatalogProduct {
  sku: string;
  /** GTIN/EAN: 8, 12, 13 или 14 цифр с верной контрольной цифрой. */
  gtin: string | null;
  brand: string | null;
  model: string | null;
  /** Ключевые атрибуты: имя → значение строкой (`"вес": "500 г"`). */
  attributes: Record<string, string>;
  title: string;
  category: string;
  price: Money;
  availability: CatalogAvailability;
  /** Хотя бы один вариант доставки. */
  delivery: CatalogDelivery[];
  /** Время обновления у продавца, ISO 8601 с часовым поясом. */
  updatedAt: string;
  /** Желательно. */
  description?: string;
  /** Желательно: адреса фото. */
  images?: string[];
}

/** Наличие. `quantity` — если продавец его сообщает. */
export interface CatalogAvailability {
  inStock: boolean;
  quantity?: number;
}

/** Вариант доставки: срок в днях и стоимость. `region` — код из `CatalogShop.deliveryRegions`, без него — во все регионы магазина. */
export interface CatalogDelivery {
  region?: string;
  minDays: number;
  maxDays: number;
  cost: Money;
}
