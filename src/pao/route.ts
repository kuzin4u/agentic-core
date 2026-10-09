// Внутренний модуль заглушки: не реэкспортируется из /pao.

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Шаблон пути ПАО → регулярное выражение: буквальные части экранируются целиком, `{имя}` — один сегмент пути. */
export function routePattern(path: string): RegExp {
  const parts = path.split(/(\{[^}]+\})/).map((part) => {
    const m = /^\{([A-Za-z_]\w*)\}$/.exec(part);
    if (m) return `(?<${m[1]}>[^/]+)`;
    if (part.includes("{") || part.includes("}")) throw new Error(`PAO_PATH_TEMPLATE ${path}`);
    return escapeRegExp(part);
  });
  return new RegExp(`^${parts.join("")}$`);
}
