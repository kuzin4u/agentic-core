# Изменения agentic-core

Версии — по тегам `vX.Y.Z` на коммитах слияния `main`. До 1.0.0 ломающее изменение допускается минорной версией — только через `/decision` и с разделом «Переход» (К9 п. 8).

## v0.5.0 — меняет поведение основного входа (К12; `PaoStub` по РП23)

### Изменено
- **`canonicalJson` отказывает на значениях вне JSON (К12, расхождение №18).** `TypeError`, в `message` — код:
  - `NON_FINITE_NUMBER` — `NaN` и `±Infinity` (было `Error` с тем же сообщением);
  - `NON_PLAIN_OBJECT` — объект, у которого прототип не `Object.prototype` и не `null`: `Date`, `Map`, `Set`, `Buffer`, типизированные массивы, `RegExp`, обёртки, `Error`, экземпляры классов (было `{}` из собственных полей);
  - `NON_JSON_VALUE` — `undefined` как значение или элемент массива, дыра в массиве (было `"[]"` и `"[,1]"`), функция или `symbol` (в поле давали `{"f":undefined}`), `bigint`, циклическая ссылка (было `RangeError` переполнения стека).

  Поле объекта со значением `undefined` по-прежнему пропускается. Векторы `canonical` прежние.
- **`PaoStub` (подмодуль `/pao`) — порядок проверки по РП23 п. 6 платформы:** агент → подпись → статус. Приостановленный (`SUSPENDED`) и исключённый (`EXCLUDED`) агент получает 200 на `GET /pao/v1/agent`, на прочие методы — 403 `AGENT_SUSPENDED`; неподписанное обращение — 401 раньше статуса (было 403 на всё до подписи). Nonce запоминается только после успешной проверки. В `GET /pao/v1/agent` — только действующие ключи (как у Платформы).

### Добавлено
- `PaoStubAgent`: `status` `EXCLUDED`, `operator`, `class`, `level`, `rateLimitPerMin`. `PaoStubKey` (новый тип ключа): `validFrom`, `validTo` (ключ с наступившим `validTo` — `EXPIRED` на момент проверки), `status` необязателен (по умолчанию `ACTIVE`).
- `PaoStubOptions`: `keyTtlDays` (90), `keyOverlapDays` (7).
- `PaoStubCall`: `method`, `path`, `code` (код отказа ПАО), `kid` (keyid из `Signature-Input`).
- **`POST /pao/v1/agent/keys` без своего обработчика** — регистрация по РП23 п. 2–4, доп. 1, 6, 7 и РП31 п. 2: `kid` — отпечаток RFC 7638; свой действующий ключ повторно — тот же `Key` 201; `alg` не из `configuration.algorithms` (разбор есть только для `ed25519`), ключ не разбирается, неканоническая запись, слабый ключ, ключ другого агента, свой отозванный или истёкший — 422 `KEY_INVALID`; нет `alg` или `public_key` — 400 `REQUEST_INVALID`. Новый ключ дописывается в `keys` агента и сразу годен для подписи; прежним действующим `validTo` сокращается до `now + keyOverlapDays`.

### Переход с 0.4.x
1. **`canonicalJson`, а через неё журнал и идемпотентность.** `payload` в `HashChainJournal`/`AsyncHashChainJournal`/`PgJournalStore`, тело в `IdempotencyStore`/`AsyncMemoryIdempotencyStore`/`PgIdempotencyStore` и результат асинхронных хранилищ идемпотентности теперь бросают `TypeError` на значениях выше. До передачи: дата → строка ISO 8601 (`d.toISOString()`), `Map` → `Object.fromEntries(m)`, `Set` → `[...s]`, экземпляр класса → простой объект, `Buffer` → строка base64. Ловушки по `instanceof Error` и по `message === "NON_FINITE_NUMBER"` работают как прежде.
2. **Тесты против `PaoStub`.** Если тест ждал 403 `AGENT_SUSPENDED` на `GET /pao/v1/agent` или на неподписанное обращение приостановленного агента — теперь 200 и 401 соответственно. Если тест ждал в `GET /pao/v1/agent` отозванные или истёкшие ключи — их там больше нет. `POST /pao/v1/agent/keys` без обработчика раньше давал 500 и запись в `violations`, теперь регистрирует ключ; свой обработчик по-прежнему имеет приоритет.
3. **Типы `/pao`.** `PaoStubAgent.status` получил `EXCLUDED` — исчерпывающий `switch` по нему дополните; `keys[].status` (`PaoStubKey`) необязателен — при strict читайте как `k.status ?? "ACTIVE"`; в `PaoStubCall` новые обязательные `method` и `path` — если тест сам собирает такой объект, добавьте их.
4. **Nonce в `PaoStub`.** Отклонённое обращение (неверная подпись, окно, отозванный ключ) nonce больше не занимает: повтор с тем же nonce после 401 принимается, если подписан верно.
5. **Фикстура агентов.** Регистрация ключа без обработчика меняет переданный объект: дописывает ключ в `agents[i].keys` и сокращает `validTo` прежних. Общую фикстуру на несколько тестов или заглушек копируйте (`structuredClone`) для каждой.

## v0.4.0 — ломающий (ПАО 1.3.0, К11)

### Добавлено
- **ПАО 1.3.0 (РП31 платформы) в `/pao`:** коды `ErrorCode` `REQUEST_INVALID` (400, `after_fix`, тело не по схеме метода) и `KEY_INVALID` (422, `after_fix`, ключ не принят в `POST /pao/v1/agent/keys`); строки в `PAO_ERRORS`; `PAO_VERSION` — `1.3.0`, `PAO_SPEC_SHA256` — `46e1c7e6…07c7`. Клиент на оба кода не повторяет, заглушка отвечает по `PAO_ERRORS`.
- Основной вход и векторы не изменились.

### Переход с 0.3.x
1. **`ErrorCode` расширен.** Таблицы `Record<ErrorCode, …>` и исчерпывающие `switch` по `ErrorCode` без `REQUEST_INVALID` и `KEY_INVALID` не соберутся: добавьте обе строки (`after_fix` — ошибка вызывающему, без повтора). Сверка набора кодов с ядром (у платформы — `ERROR_CODES_MATCH_CORE`) — на теге `v0.4.0`.
2. Копия спецификации у потребителя (`PAO_SPEC_SHA256`) — обновить до ПАО 1.3.0 тем же файлом (sha-256 `46e1c7e6fdab61e5b7e5708326da5e8ae7b8dc7acc952e1c2ad177663bfc07c7`).

## v0.3.0 — ломающий (CO-1, CO-2, К6, К9, К10)

### Добавлено
- **Журнал на PostgreSQL (CO-1, К6 пп. 1–9):** `SqlClient`, `applyMigrations`, `migrationsDir`, `chainGenesis`, `AsyncJournalStore`, `AsyncMemoryJournalStore`, `AsyncHashChainJournal`, `JournalAppendConflict`, `PgJournalStore`; миграция `sql/001_journal.sql`; векторы `journal_chain_genesis`.
- **Суммы (К9):** `Money`, `CurrencyCode`, `MoneyError`, `MoneyErrorCode`, `money`, `assertMinor`, `isCurrencyCode`, `addMoney`, `splitMoney`; векторы `money`.
- **Удержания на PostgreSQL (CO-2, К6 п. 10):** `AsyncHoldLedger`, `AsyncMemoryHoldLedger`, `PgHoldLedger`; миграция `sql/002_holds.sql`.
- **Идемпотентность на PostgreSQL (К6 п. 11):** `AsyncIdempotencyStore`, `IdempotencyOptions`, `AsyncMemoryIdempotencyStore`, `PgIdempotencyStore`, `IdempotencyInProgress`; миграция `sql/003_idempotency.sql`.
- **Nonce на PostgreSQL (К6 пп. 12–13):** `AsyncNonceStore`, `NonceStoreOptions`, `AsyncMemoryNonceStore`, `PgNonceStore`, `verifyRequestAsync`; миграция `sql/004_nonces.sql`.
- **Слабые ключи Ed25519 (К10):** `isWeakEd25519(x: Buffer)` из основного входа; векторы `ed25519_weak_keys`.
- Векторы — `version` 2; разделы `canonical`, `journal`, `journal_chain_genesis` побайтно прежние.

### Переход с 0.2.x
1. **`money`.** `assertKop` и `splitByWeights` удалены.
   - `assertKop(n)` → `assertMinor(n)`: целое ≥ 0 и `Number.isSafeInteger`; ошибка — `MoneyError("BAD_AMOUNT")`.
   - `splitByWeights(total, weights)` → `splitMoney({ amount: total, currency }, weights)`: возвращает `Money[]`.
   - **Веса — неотрицательные целые.** Дробные веса прежней функции переведите в целые: доли — в базисных пунктах (`0.25` → `2500` из `10000`) или миллионных долях. Остаток теперь уходит последней доле **с положительным весом** (было — просто последней).
2. **`holds`.** Суммы — `Money`, счёт и его удержания в одной валюте.
   - `openAccount(id, limit: number)` → `openAccount(id, { amount, currency })`.
   - `reserve(account, amount: number, ref, expires_at?)` → `reserve(account, { amount, currency }, ref, expires_at?)`.
   - `commit(holdId, amount: number, releaseRest?)` → `commit(holdId, { amount, currency }, releaseRest?)`.
   - `available(id)` возвращает `Money`, а не число; у `Account` и `Hold` — поле `currency`.
   - Новые коды `HoldError`: `CURRENCY_MISMATCH` (валюта не счёта), `ACCOUNT_CONFLICT` (повторное открытие с другим лимитом или валютой; прежде счёт молча перезаписывался и терял `reserved`), `BAD_CURRENCY` (код не по шаблону). `switch` по `HoldError.code` дополните.
   - `expires_at` и `expire(now)` — безопасные целые мс, иначе `RangeError`.
3. **PostgreSQL.** Миграции `sql/001…004` применяйте своим средством или `applyMigrations(pool)`. Хранилищам передавайте пул или соединение в autocommit, не клиент внутри своей транзакции.
4. **Node ≥ 20.19** (`engines`; было `>=20`): на 20.0–20.18 пакет не поддерживается (vitest 5 и матрица CI; расхождение №16).
5. Перенос ядра на другой язык (К3) обязан пройти новые разделы векторов `money`, `holds` (переписан), `ed25519_weak_keys`.

## v0.2.2
- Расхождение №12: `ed25519Verifier` отвергает слабые открытые ключи Ed25519; публичный API без изменений.

## v0.2.1
- ПАО 1.2.0 (К7): таблица ошибок `PAO_ERRORS` из `x-pao-errors`, `retry` по ней в клиенте и заглушке.

## v0.2.0
- CO-3 (К5): подмодуль `/pao` — типы ПАО, клиент с подписью и повторами, сервер-заглушка.
