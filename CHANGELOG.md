# Изменения agentic-core

Версии — по тегам `vX.Y.Z` на коммитах слияния `main`. До 1.0.0 ломающее изменение допускается минорной версией — только через `/decision` и с разделом «Переход» (К9 п. 8).

## v0.10.0 — только добавление (матрица испытаний и эмулятор ситуаций, К19; Р-74)

### Добавлено
- **Подмодуль `/trials`** (`import … from "@kuzin4u/agentic-core/trials"`, К19). Основной вход его не реэкспортирует.
  - Формат ситуации `TrialSituation` — только данные: `refs` (`РЗ-N` / `КП-N`), `params`, `exclude`, `expect` (правила `when`), `rejected` или `rejectedNone`; `outcomeMatches` — по подмножеству ключей. `checkSituations` — замечания `TRIALS_*` без текста.
  - Сетка и выборка: `expandCases` (`grid` — до `maxCases`, `sample` — mulberry32 от обязательного зерна), ключ случая `<id>#<номер>`, `caseByKey`, `mulberry32`.
  - Движок `runTrials(stand, situations, mode, options)` против порта `TrialStand` потребителя, режим «отклонённый вариант обязан провалиться» (`any` по умолчанию, `all`), `TRIAL_UNSUPPORTED`, `replayCase`, `formatTrialFailure`.
  - Полнота `checkCoverage({ scope, situations, exclusions })`, `trialScope(repo)`, «вне испытаний» `TrialExclusion` с основаниями `TRIAL_EXCLUSION_BASES` (`legal`, `pilot`, `external`, `process`).
  - Реестр `TRIAL_FORKS` (развилки Р-1…Р-76 чата, копия комментария PR #35, `778e3abf…`), `TRIAL_CONFLICTS` (К1…К20 пула, `0bc924e`), `TRIAL_ITEMS`, `TRIAL_REPOS`; источники — `src/trials/registry/SOURCE.md`, скрипт `npm run gen:trials`.
- Каталог испытаний ядра (`tests/trials/`): область `agentic-core` покрыта — 12 пунктов ситуациями, 8 процессных — `process`.

### Не изменилось
- Основной вход, `/pao`, `/catalog`, `/diag`, векторы, SQL-миграции, `spec/`. `dependencies` пусты.
- Строгий разбор дат перенесён в v0.11.0 (К19).

## v0.9.0 — клиент ПАО: перенаправления, необязательный подписант, коды клиента (К18; #32 агента)

### Добавлено
- **`PAO_CLIENT_DIAG`** (`/pao`) — реестр кодов отказов клиента ПАО в формате `/diag`, `component: "core"`, `since: "0.9.0"`. Коды: `PAO_CLIENT_REDIRECT` и `PAO_CLIENT_SIGNER_MISSING`, оба с `action: "after_fix"`. Перечень `PAO_CLIENT_CODES`, тип `PaoClientCode`. `PAO_DIAG` не изменился: в нём 20 кодов спецификации.
- **`PaoCallError.clientCode`** — код отказа самого клиента; в этом случае `message` равен коду. Геттер `code` по-прежнему возвращает только `ErrorCode` ПАО.
- **`PaoUnsignedOperationKey`** (генерируется из спецификации: операции без `Signature`) и **`PaoAllowedOperationKey<O>`**. `PaoClient` стал обобщённым, `PaoClient<O extends PaoClientOptions = PaoClientOptions>`.
- **`PaoClientOptions.signer` необязателен.** Без подписанта `call` по типам принимает только неподписанные операции (сейчас `GET /.well-known/pao-configuration`). Подписанная операция не компилируется, а в JS даёт отказ `PAO_CLIENT_SIGNER_MISSING` до запроса в сеть. Агент может снять подписанта-заглушку.

### Изменено
- **`PaoClient` не следует HTTP-перенаправлениям** — ни у подписанных, ни у неподписанных операций (#32). В `fetch` уходит `redirect: "manual"`. Ответ 3xx, `opaqueredirect` или ответ с `redirected === true` дают `PaoCallError` с `clientCode: "PAO_CLIENT_REDIRECT"`, без повтора и без `inspectResponse`. До v0.9.0 клиент шёл по `Location` и уносил туда подпись, заголовки агента и тело. В ПАО 1.4.0 ответов 3xx нет (`x-pao-errors`, `errors` операций), `PaoStub` их не даёт, поэтому «Перехода» нет. Свой `fetch` потребителя должен передавать `redirect` дальше: иначе запрос уйдёт на чужой адрес раньше отказа.

### Не изменилось
- Основной вход, векторы, SQL-миграции, `spec/` (ПАО 1.4.0, `48bd3397…9ad9da`), состав подписи, повторы по `retry`, `PaoStub` — как в v0.8.0. `dependencies` пусты. Клиент с подписантом и клиент из переменной типа `PaoClientOptions` принимают все операции, как прежде.
- Строгий разбор дат перенесён в v0.10.0 (К18 п. 6).

## v0.8.0 — только добавление (система диагностики, К17; CO-1 агента)

### Добавлено
- **Подмодуль `/diag`** (`import … from "@kuzin4u/agentic-core/diag"`, К17). Основной вход его не реэкспортирует.
  - Формат записи реестра кодов отказов `DiagEntry`: `code`, `component`, `source[]`, `action`, `human`, `operator` (тексты по языкам, `ru` обязателен), `norm`, `since`. Перечни `DIAG_COMPONENTS`, `DIAG_SOURCES`, `DIAG_ACTIONS`.
  - `checkDiagRegistry(codes, registry, { langs })` — проверка полноты, замечания `DIAG_*` без текста.
  - `diagAction(registry, code)` — для кода не из реестра возвращает `stop`.
  - **Отчёт самопроверки (К17 п. 8):** `SelfCheckReport`, `SelfCheckItem`, `SelfCheckStatus`, `buildSelfCheckReport` (`ready` вычисляется: нет ни одного `fail`), `checkSelfCheckReport` — замечания `SELFCHECK_*`. `checked_at` проверяется только по формату, строгий разбор дат — в v0.9.0.
- **`PAO_DIAG`** (`/pao`) — 20 записей, по одной на код `ErrorCode` ПАО 1.4.0; `action` — по `retry` из `x-pao-errors`. `PAO_RETRY_ACTION` — соответствие `retry` → действие.
- **`CATALOG_DIAG`** (`/catalog`) — 32 записи на коды `CatalogIssueCode`, `A5SignalCode`, `LiveCheckCode`. Перечни `CATALOG_ISSUE_CODES`, `A5_SIGNAL_CODES`, `LIVE_CHECK_CODES`, `CATALOG_DIAG_CODES`; тип `CatalogDiagCode`. Действия `LIVE_*` — по решению владельца 19.10.

### Изменено
- **`PaoClient`: запрос без подписи (`GET /.well-known/pao-configuration`) больше не отправляет `x-agent-code`, `x-timestamp`, `x-nonce`** (CO-1 агента, #31). Подписанные операции не меняются. В ПАО 1.4.0 у `/.well-known/pao-configuration` нет параметров `AgentCode`, `X-Timestamp`, `X-Nonce` и подписи, `PaoStub` отвечает 200 и без них, поэтому «Перехода» нет.

### Не изменилось
- Основной вход, векторы, SQL-миграции, `spec/` (ПАО 1.4.0, `48bd3397…9ad9da`) — как в v0.7.0. `dependencies` пусты.

## v0.7.0 — ПАО 1.4.0, для типов ломающий (К16)

### Изменено
- **Копия ПАО 1.4.0** (подмодуль `/pao`, К16; РП37, РП38 платформы). `spec/agent-protocol.yaml` побайтно взят из agentic-ps-platform `docs/core/agent-protocol.yaml` на `main` (`4948c74`, слияние PR #30), sha-256 `48bd339746e83c0468fb8354d6b2d8f0c82020904af549063d3e44b1a51ad9da`. `PAO_VERSION` — `1.4.0`, `PAO_SPEC_SHA256` — `48bd3397…9ad9da`. Промежуточная редакция `4569a86b…` (только ответы РП33–РП35, план патча v0.6.1) не выпускается: её перекрыла 1.4.0.
- **`Mandate.agent_code` — обязательное поле** (РП37 п. 8). Платформа отдавала его всегда; для протокола совместимо (AGENT-PROTOCOL §7 ред. 5), для типов TypeScript — нет.
- **`PaoStub` проверяет ответ обработчика по схеме 1.4.0:** ответ `Mandate` без `agent_code` даёт запись в `violations`.
- `PAO_OPERATIONS["POST /pao/v1/mandates"].errors` — 400, 401, 403, 404, 409, 503 (было 400, 409); `PAO_OPERATIONS["GET /pao/v1/mandates/{id}"].errors` — 401, 403, 404, 503 (было 404) — РП33, РП34.

### Добавлено
- `Mandate.revocation_order?: string` — порядок отзыва; задаёт Платформа из соглашения участника, агент в запросе его не передаёт, а показывает человеку из ответа (РП37).
- `Evidence.records?: JournalRecord[]` и тип `JournalRecord` (`seq`, `kind`, `ref`, `parent_ref`, `at`, `payload`, `prev_hash`, `hash`) — вся цепочка журнала согласий: по ней агент проверяет хэши и подпись банка без Платформы (РП38 п. 7).
- Описания у `201` `POST /pao/v1/mandates` (РП35: после `201` проверять `status`), у `verify`, `relinquish`, `evidence` — в спецификации; на типы не влияют.

### Чего в ПАО 1.4.0 нет
- **Подпись ответов и событий Платформы — с ПАО 1.5.0, не 1.4.0** (РП37 п. 9; AGENT-PROTOCOL ред. 5, §2). В 1.2.0–1.4.0 Платформа их не подписывает. Прежний пакет «ПАО 1.4.0» (подпись ответов и событий, `use` у ключа Платформы, `CERTIFICATE_INVALID`, `PaymentPackage`, общие 401/403/429/503, пакет агента п. 1–4, задел РП30) теперь называется ПАО 1.5.0; проверка подписи ответа и события (`verifyResponse`) в ядре — тоже с 1.5.0.

### Не изменилось
- `ErrorCode`, `PAO_ERRORS` (`x-pao-errors`), `MandateRequest`; клиент ПАО — поведение прежнее.
- Основной вход, `/catalog`, векторы, SQL-миграции — как в v0.6.0.

### Переход с 0.6.x
1. **`agent_code` в `Mandate` обязателен.** Каждый объект типа `Mandate`, который потребитель строит сам (ответы обработчиков `PaoStub`, заготовки в тестах, ответы сервера), должен содержать `agent_code: string` — иначе не соберётся TypeScript. Чтение `m.agent_code` больше не требует проверки на `undefined`.
2. **`PAO_VERSION` — `1.4.0`.** Сверки версии (`PAO_VERSION === "1.3.0"`, контрактные тесты, заголовки копий спецификации) перевести на `1.4.0`; хэш копии — `48bd3397…9ad9da`.
3. **`PaoStub.violations`.** Обработчик, который отдаёт `Mandate` без `agent_code`, теперь даёт нарушение вида `POST /pao/v1/mandates ответ $.agent_code: обязательное поле`; тесты, проверяющие `violations` на пустоту, покраснеют — добавить `agent_code` в ответ обработчика.
4. `revocation_order` и `records` читать как необязательные (в ответах Платформы `revocation_order` есть всегда, но тип оставлен необязательным по схеме).

## v0.6.0 — только добавление (каталог продавца: К8, К14, К15)

### Добавлено
- **Подмодуль `/catalog`** (`import … from "@kuzin4u/agentic-core/catalog"`). Основной вход его не реэкспортирует.
  - **Модель и валидатор (К8, CO-К1):** типы `CatalogShop`, `CatalogReturns`, `CatalogProduct`, `CatalogAvailability`, `CatalogDeliveryMethod`, `CatalogDelivery`; функции `validateShop`, `validateProduct`, `isInn`, `isGtin`; типы `CatalogIssue`, `CatalogIssueCode`.
  - **Проверка A5 (К8):** `checkProductA5`, `checkShopA5`, типы `A5Signal`, `A5SignalCode`.
  - **Коннектор YML (К14, CO-К3 часть 1):** `parseYml`, типы `YmlOptions`, `YmlResult`. Разборщик XML свой, DTD не исполняет: короткий `DOCTYPE` пропускается, внутреннее подмножество даёт отказ. Есть пределы размера и вложенности, разбор линеен.
  - **Живая проверка цены и наличия (К15, CO-К3 часть 2):** `checkLiveOffer`, `compareLiveOffer`, порт `LiveOfferSource`, типы `LiveOfferRequest`, `LiveOffer`, `LiveCheckCode`, `LiveCheckOptions`, `LiveCheckResult`. Коды `LIVE_*` без текста; цена сверяется строгим равенством.
- Подробности и ограничения — в README, раздел «Каталог продавца».

### Не изменилось
- Основной вход, `/pao`, `spec/`, векторы и SQL-миграции — побайтно как в v0.5.0. `PAO_VERSION` остаётся `1.3.0`, `PAO_SPEC_SHA256` — `46e1c7e6…07c7`.
- **ПАО с ответами РП33–РП35 платформы (целевой sha-256 `4569a86b…`) в v0.6.0 не входит.** Он выйдет отдельным патчем v0.6.1 после слияния PR #30 платформы в её `main` (решение владельца 18.10.2026, вариант Б).

### Переход с 0.5.x
Не нужен: ничего не удалено и не изменено. Достаточно поднять ссылку до `#v0.6.0`.

## v0.5.0 — меняет поведение основного входа (К12; `PaoStub` по РП23 — К13)

### Изменено
- **`canonicalJson` отказывает на значениях вне JSON (К12, расхождение №18).** `TypeError`, в `message` — код:
  - `NON_FINITE_NUMBER` — `NaN` и `±Infinity` (было `Error` с тем же сообщением);
  - `NON_PLAIN_OBJECT` — объект, у которого прототип не `Object.prototype` и не `null`: `Date`, `Map`, `Set`, `Buffer`, типизированные массивы, `RegExp`, обёртки, `Error`, экземпляры классов (было `{}` из собственных полей);
  - `NON_JSON_VALUE` — `undefined` как значение или элемент массива, дыра в массиве (было `"[]"` и `"[,1]"`), функция или `symbol` (в поле давали `{"f":undefined}`), `bigint`, циклическая ссылка (было `RangeError` переполнения стека).

  Поле объекта со значением `undefined` по-прежнему пропускается. Векторы `canonical` прежние.
- **`PaoStub` (подмодуль `/pao`, К13, расхождение №19) — порядок проверки по РП23 п. 6 платформы:** агент → подпись → статус. Приостановленный (`SUSPENDED`) и исключённый (`EXCLUDED`) агент получает 200 на `GET /pao/v1/agent`, на прочие методы — 403 `AGENT_SUSPENDED`; неподписанное обращение — 401 раньше статуса (было 403 на всё до подписи). Nonce запоминается только после успешной проверки. В `GET /pao/v1/agent` — только действующие ключи (как у Платформы).

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
