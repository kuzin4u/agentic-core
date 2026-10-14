import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Клиент SQL, который передаёт потребитель (К6): `pg.Pool` и `pg.Client` подходят без обёртки.
 *  Пакет не открывает транзакций: каждая операция хранилища — одна команда. */
export interface SqlClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

const MIGRATION_NAME = /^\d{3}_[a-z0-9_]+\.sql$/;

/** Каталог `sql/` пакета: `src/sql.ts` → `../sql`, `dist/src/sql.js` → `../../sql`. */
export function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const d of [join(here, "..", "sql"), join(here, "..", "..", "sql")]) if (existsSync(d)) return d;
  throw new Error("каталог sql/ пакета не найден");
}

/** Применить SQL-миграции пакета по порядку номеров, учёт — в `core_migrations`.
 *  Файл и отметка о нём — одной командой в транзакции: файл либо применён и отмечен, либо нет.
 *  Для тестов и простых случаев; у потребителя — его средство миграций. */
export async function applyMigrations(client: SqlClient, dir: string = migrationsDir()): Promise<string[]> {
  await client.query("CREATE TABLE IF NOT EXISTS core_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await client.query<{ name: string }>("SELECT name FROM core_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => MIGRATION_NAME.test(f)).sort()) {
    if (done.has(name)) continue;
    const body = readFileSync(join(dir, name), "utf8");
    // name проверен выражением MIGRATION_NAME — подстановка в текст безопасна
    await client.query(`BEGIN;\n${body}\n;INSERT INTO core_migrations (name) VALUES ('${name}');\nCOMMIT;`);
    applied.push(name);
  }
  return applied;
}
