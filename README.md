# agentic-core

Общие механизмы агентной коммерции и расчётов: каноническая сериализация, журнал с хэш-цепочкой, удержания (резерв → закрепление → освобождение), идемпотентность, подпись HTTP-обращений, доставка событий, деньги в копейках. Без внешних зависимостей.

```
npm install
npm test
```

Подключение: `"@kuzin4u/agentic-core": "git+https://github.com/kuzin4u/agentic-core.git#v0.2.2"`. Типы, клиент и сервер-заглушка ПАО — `import … from "@kuzin4u/agentic-core/pao"` (К5). Правила и состав — [`CLAUDE.md`](CLAUDE.md).

## Журнал на PostgreSQL (К6, с v0.3.0)

Драйвер — у потребителя: пакет принимает `SqlClient { query(text, params) }`, `pg.Pool` подходит без обёртки. Миграции — файлы `sql/NNN_*.sql` в пакете; применяйте своим средством миграций или `applyMigrations(pool)`.

```ts
import pg from "pg";
import { applyMigrations, PgJournalStore, AsyncHashChainJournal } from "@kuzin4u/agentic-core";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await applyMigrations(pool);
const journal = new AsyncHashChainJournal(new PgJournalStore(pool, "consents"));
await journal.append("record", "R-1", { amount: 50000 });
await journal.verify(); // { ok: true }
```

Таблица `core_journal` — только добавление: UPDATE, DELETE и TRUNCATE отклоняет триггер. Первая запись цепочки привязана к её имени (`chainGenesis`). Удалённый хвост по одной таблице не обнаружить — храните последние `seq` и `hash` отдельно (К6 п. 9).
