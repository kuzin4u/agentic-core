import { PAO_SCHEMAS } from "./types.js";

/** Проверка значения по схеме ПАО (подмножество OpenAPI 3.0, которое использует спецификация).
 *  Неизвестные поля допускаются: агент обязан их игнорировать (AGENT-PROTOCOL.md §7). Возвращает список нарушений. */
export function validatePao(schema: unknown, value: unknown, at = "$"): string[] {
  const s = schema as Schema;
  if (s.$ref) {
    const name = s.$ref.replace("#/components/schemas/", "");
    const target = PAO_SCHEMAS[name];
    if (!target) return [`${at}: неизвестная схема ${s.$ref}`];
    return validatePao(target, value, at);
  }
  if (s.allOf) return s.allOf.flatMap((x) => validatePao(x, value, at));
  if (value === null) return s.nullable || s.enum?.includes(null) ? [] : [`${at}: null недопустим`];
  if (s.enum && !s.enum.includes(value as never)) return [`${at}: ${JSON.stringify(value)} вне перечня`];
  switch (s.type) {
    case "string":
      if (typeof value !== "string") return [`${at}: ожидалась строка`];
      if (s.format === "date-time" && !Number.isFinite(Date.parse(value))) return [`${at}: не дата-время`];
      return [];
    case "integer":
      if (!Number.isInteger(value)) return [`${at}: ожидалось целое`];
      return s.minimum !== undefined && (value as number) < s.minimum ? [`${at}: меньше ${s.minimum}`] : [];
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? [] : [`${at}: ожидалось число`];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${at}: ожидалось логическое`];
    case "array":
      if (!Array.isArray(value)) return [`${at}: ожидался массив`];
      return value.flatMap((v, i) => validatePao(s.items, v, `${at}[${i}]`));
  }
  if (s.type === "object" || s.properties) {
    if (typeof value !== "object" || Array.isArray(value)) return [`${at}: ожидался объект`];
    const obj = value as Record<string, unknown>;
    const out: string[] = [];
    for (const k of s.required ?? []) if (obj[k] === undefined) out.push(`${at}.${k}: обязательное поле`);
    for (const [k, v] of Object.entries(obj)) {
      const p = s.properties?.[k] ?? (typeof s.additionalProperties === "object" ? s.additionalProperties : undefined);
      if (p && v !== undefined) out.push(...validatePao(p, v, `${at}.${k}`));
    }
    return out;
  }
  return [];
}

interface Schema {
  $ref?: string; allOf?: unknown[]; type?: string; format?: string; enum?: unknown[]; nullable?: boolean; minimum?: number;
  items?: unknown; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown;
}
