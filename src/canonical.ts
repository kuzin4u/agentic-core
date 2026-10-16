import { createHash } from "node:crypto";

/** Каноническая сериализация JSON: ключи объектов по алфавиту, без пробелов. Основа хэшей и подписей.
 *  Значения вне JSON — TypeError (К12): NON_FINITE_NUMBER — NaN и ±Infinity; NON_PLAIN_OBJECT — объект с прототипом
 *  не Object.prototype и не null (Date, Map, Set, экземпляры классов); NON_JSON_VALUE — undefined как значение или
 *  элемент массива (и дыра в массиве), функция, symbol, bigint, циклическая ссылка. Поле объекта со значением
 *  undefined пропускается. */
export function canonicalJson(value: unknown): string {
  return write(value, new Set());
}

/** `path` — объекты на пути от корня: повтор на пути — цикл; общая ссылка в разных ветвях циклом не считается. */
function write(value: unknown, path: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("NON_FINITE_NUMBER");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError("NON_JSON_VALUE");
  }
  const obj = value as object;
  if (path.has(obj)) throw new TypeError("NON_JSON_VALUE");
  path.add(obj);
  let out: string;
  if (Array.isArray(obj)) {
    // По индексу, а не map: map пропускает дыры, и [, 1] дал бы "[,1]".
    const items: string[] = [];
    for (let i = 0; i < obj.length; i++) items.push(write(obj[i], path));
    out = "[" + items.join(",") + "]";
  } else {
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("NON_PLAIN_OBJECT");
    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
    out = "{" + keys.map((k) => JSON.stringify(k) + ":" + write(rec[k], path)).join(",") + "}";
  }
  path.delete(obj);
  return out;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
