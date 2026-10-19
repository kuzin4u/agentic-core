# agentic-core

Общие механизмы агентной коммерции и расчётов: каноническая сериализация, журнал с хэш-цепочкой, удержания (резерв → закрепление → освобождение), идемпотентность, подпись HTTP-обращений, доставка событий, суммы в минимальных единицах с валютой. Без внешних зависимостей во время выполнения.

```
npm install
npm test
```

Подключение: `"@kuzin4u/agentic-core": "git+https://github.com/kuzin4u/agentic-core.git#v0.10.0"` (после тега; v0.10.0 — только добавление: подмодуль `/trials`, матрица испытаний и эмулятор ситуаций, К19; v0.9.0 — клиент ПАО не следует перенаправлениям, подписант необязателен, реестр `PAO_CLIENT_DIAG`, К18; v0.8.0 — только добавление: `/diag`, реестры кодов отказов, отчёт самопроверки, К17; v0.7.0 — ПАО 1.4.0, для типов ломающий: `Mandate.agent_code` обязателен, К16; переход с 0.6.x, 0.4.x, 0.3.x и 0.2.x — [`CHANGELOG.md`](CHANGELOG.md), раздел «Переход»). Типы, клиент и сервер-заглушка ПАО — `import … from "@kuzin4u/agentic-core/pao"` (К5). Каталог продавца — `import … from "@kuzin4u/agentic-core/catalog"` (К8, с v0.6.0). Реестр кодов отказов и отчёт самопроверки — `import … from "@kuzin4u/agentic-core/diag"` (К17, с v0.8.0). Матрица испытаний — `import … from "@kuzin4u/agentic-core/trials"` (К19, с v0.10.0). Правила и состав — [`CLAUDE.md`](CLAUDE.md).

## Каноническая сериализация (К12, с v0.5.0)

`canonicalJson` принимает только значения JSON: простые объекты (прототип `Object.prototype` или `null`, в том числе после `JSON.parse`), массивы, строки, конечные числа, `true`/`false`, `null`. Иное — `TypeError` с кодом в `message`: `NON_FINITE_NUMBER` (`NaN`, `±Infinity`), `NON_PLAIN_OBJECT` (`Date`, `Map`, `Set`, `Buffer`, экземпляры классов), `NON_JSON_VALUE` (`undefined` как значение, элемент или дыра массива, функция, `symbol`, `bigint`, циклическая ссылка). Поле объекта со значением `undefined` пропускается. Так же отказывают `payload` журнала и тело и результат идемпотентности: дату передавайте строкой ISO 8601, `Map` — объектом, `Set` — массивом.

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

## Суммы (К9, с v0.3.0)

Сумма — `Money { amount, currency }`: `amount` — целое число минимальных единиц (`Number.isSafeInteger`, ≥ 0), `currency` — код ISO 4217 (`RUB`, `JPY`, `KWD`) или код актива потребителя (`USDC`), шаблон `^[A-Z][A-Z0-9]{2,11}$`. Таблицы знаков после запятой в ядре нет. `addMoney` и `splitMoney` — только в одной валюте (иначе `CURRENCY_MISMATCH`); сумма выше `MAX_SAFE_INTEGER` — `BAD_AMOUNT`. Веса `splitMoney` — целые (базисные пункты, миллионные доли); остаток — последней доле с положительным весом.

## Удержания на PostgreSQL (К6 п. 10, с v0.3.0)

```ts
import { PgHoldLedger, money } from "@kuzin4u/agentic-core";

const holds = new PgHoldLedger(pool); // таблицы core_hold_accounts, core_holds — sql/002_holds.sql
await holds.openAccount("acc-1", money(500000, "RUB"));
const h = await holds.reserve("acc-1", money(189000, "RUB"), "op-1");
await holds.commit(h.id, money(150000, "RUB"), true); // остаток освобождается
```

Остаток защищён дважды: условие `limit − committed − reserved ≥ amount` в том же `UPDATE`, что резервирует, и `CHECK` в базе. Без условия перерасход останавливает `CHECK` (проверено подставной поломкой `8a359d8`: 20 одновременных резервов). Каждая операция — одна SQL-команда: передавайте пул или соединение в autocommit, не клиент внутри своей транзакции (ошибка повтора ref прервала бы её). `HoldLedger` в памяти и `AsyncMemoryHoldLedger` — те же операции и векторы.

## Изменение предела счёта удержаний (К20 п. 3, с v0.11.0)

```ts
await holds.setLimit("acc-1", money(700000, "RUB")); // расширение — сразу
```

- Порядок проверок (в памяти и на PG одинаков): сумма — безопасное целое ≥ 0 (`BAD_AMOUNT`), код валюты (`BAD_CURRENCY`); счёт есть (`UNKNOWN_ACCOUNT`); валюта счёта (`CURRENCY_MISMATCH`); новый предел ≥ `committed + reserved`, иначе **`LIMIT_BELOW_USED`**, счёт не меняется. Ровно до использованного — можно (доступно 0).
- Тот же предел — счёт без изменений, `version` не растёт; иначе `version + 1`. Удержания не трогаются. Ссылки `ref` нет: результат определяется значением.
- Кто вправе менять предел и журнал изменения — у потребителя; ядро полномочий не проверяет.
- `openAccount` после `setLimit` сверяет с **текущим** пределом: повтор с прежним — `ACCOUNT_CONFLICT`, с новым — прежний счёт.
- «Сузить сколько можно»: при `LIMIT_BELOW_USED` прочитать `account(id)` и вызвать `setLimit` с `committed + reserved`. Между чтением и вызовом одновременный `reserve` может занять остаток — тогда снова `LIMIT_BELOW_USED`, инвариант не нарушается; повторить.
- На PG — одна команда `UPDATE … WHERE committed + reserved <= $предел AND limit_amount <> $предел`: условие и смена предела под блокировкой строки счёта; одновременный `reserve` ждёт и перепроверяет свой остаток по новому пределу. Новой миграции нет. Свои реализации `AsyncHoldLedger` у потребителя должны добавить метод (интерфейс расширен — «Переход» v0.11.0).

## Тестовые векторы

`vectors/vectors.json` — эталон для любой реализации ядра (перенос на другой язык, НСВР, Python-ядро агента). Разделы: `canonical`, `journal`, `journal_chain_genesis`, `money`, `holds`, `holds_set_limit` (К20, с v0.11.0), `ed25519_weak_keys` (К10).

- **Прогон падает на неизвестном разделе или шаге** (К20 п. 3, правило для всех реализаций): иначе новая операция «проходит» без реализации. В ядре — `tests/holds-vectors.ts` (неизвестный шаг — ошибка) и тест разделов в `tests/core.test.ts`.
- `version` растёт, когда меняется смысл прежних разделов (К9: 1 → 2). Новый раздел — добавление, `version` прежняя (К10, К20); реализация, зафиксированная на старом ядре, прежние разделы проходит без изменений.
- Реализация, заявляющая совместимость `holds` с v0.11.0, проходит и `holds_set_limit` (шаг сверяет `available` и `account`: `limit`, `committed`, `reserved`, `version`).
- Векторы меняются только через `/decision`, затем `npm run vectors`.

## Идемпотентность и nonce на PostgreSQL (К6 пп. 11–13, с v0.3.0)

```ts
import { PgIdempotencyStore, PgNonceStore, verifyRequestAsync } from "@kuzin4u/agentic-core";

const idem = new PgIdempotencyStore(pool, "gateway", { ttlMs: 24 * 3600_000, leaseMs: 60_000 }); // sql/003_idempotency.sql
const { result, replayed } = await idem.run(key, body, async () => doOperation(body));

const nonces = new PgNonceStore(pool, "gateway", { retainMs: 2 * 300_000, skewSec: 300 }); // sql/004_nonces.sql
const v = await verifyRequestAsync(req, lookupKey, { now: Date.now(), skewSec: 300, seenNonce: (n) => nonces.seen(n) });
await nonces.purge(); // по расписанию
```

- **`leaseMs` — больше самой долгой операции `fn`.** Захват ключа — аренда: по её истечении ключ перезахватывается (процесс упал во время `fn`), и `fn` дольше `leaseMs` выполнится второй раз. Одновременный вызов с тем же ключом, пока первый не завершён, получает `IdempotencyInProgress`. Результат — обычное значение JSON (объекты, массивы, строки, числа, `true`/`false`, `null`): и первый ответ, и повтор возвращают его разбор после канонической записи (`undefined` → `null`, поля `undefined` отбрасываются; `Date`, `Map`, `Set` и экземпляры классов — `TypeError`, К12).
- **`retainMs` ≥ 2 × окна** (`skewSec`): обращение с меткой на краю окна принимается ещё `skewSec` после записи nonce. С `skewSec` в параметрах меньшее значение — `RangeError`.
- `verifyRequestAsync` проверяет nonce последним, после подписи: в базу пишутся nonce только подписанных обращений. Отличие от `verifyRequest`: повтор nonce с отозванным ключом — `AGENT_KEY_REVOKED`.

## Слабые ключи Ed25519 (К10, с v0.3.0)

`isWeakEd25519(x: Buffer)` — 32 байта точки: слабый — неканоническая запись, точка не на кривой или малого порядка. `ed25519Verifier` такие ключи отвергает сам; функция — для реестров ключей у потребителей. Векторы — раздел `ed25519_weak_keys`.

## Каталог продавца (К8, с v0.6.0)

Подмодуль `/catalog` — каноническая модель каталога: агент читает каталоги только в ней, формат продавца переводит коннектор. Основной вход её не реэкспортирует. Коды отказов подмодуля — в реестре `CATALOG_DIAG` формата `/diag` (с v0.8.0, раздел «Реестр кодов отказов и отчёт самопроверки»).

- `CatalogShop` — `id`, `inn` (10 цифр — организация, 12 — ИП или самозанятый), `mcc`, `paymentMethods`, `deliveryRegions`, `returns { days, text }` (`days` = 0 — возврата нет, продовольственные товары); желательно — `readiness`, `fulfillmentRating` (0…1).
- `CatalogProduct` — `sku`, поля сопоставления `gtin`, `brand`, `model` (обязательны в записи; `null` — у продавца нет, например выпечка без штрихкода) и `attributes`, `title`, `category`, `price: Money` (К9), `availability { inStock, quantity? }`, `delivery` — хотя бы один вариант `{ method: "DELIVERY" | "PICKUP", region?, minDays, maxDays, cost: Money }` (самовывоз — за 0), `updatedAt` (ISO 8601 с поясом); желательно — `description`, `images`.

```ts
import { validateProduct, checkProductA5, checkShopA5 } from "@kuzin4u/agentic-core/catalog";

const issues = validateProduct(item, shop);    // [] или [{ code: "BAD_GTIN", path: "$.gtin" }, …]
if (issues.length === 0) {
  const a5 = [...checkProductA5(item, 2), ...checkShopA5(shop)]; // 2 — знаков после запятой у RUB, таблицы в ядре нет
  // [{ code: "A5_PRICE_MISMATCH", path: "$.description", found: 30000 }] — в тексте 300 ₽, в поле другая цена
}
```

`validateShop` и `validateProduct` не бросают исключений на данных продавца: возвращают `CatalogIssue { code, path }`, коды — `REQUIRED`, `BAD_TYPE`, `BAD_AMOUNT`, `BAD_CURRENCY`, `BAD_INN`, `BAD_MCC`, `BAD_GTIN`, `BAD_DATE`, `BAD_RANGE`, `BAD_METHOD`, `UNKNOWN_REGION` (регион варианта не входит в регионы переданного магазина). Неизвестные поля допускаются. Тексты для человека — у потребителя по коду.

Проверка A5 — после валидатора, на проверенных данных; расхождение — признак нарушения у продавца, а не ошибка разбора (`A5Signal { code, path, found }`):
- `checkProductA5(product, exponent)` — цены в `title` и `description` против `price`: число перед кодом валюты цены, для RUB ещё перед `₽`, `руб`, `р.`; код валюты — и перед числом. Разряды через пробел (обычный, неразрывный, узкий), дробная часть через точку или запятую. Каждое упоминание, отличное от `price`, — сигнал («было 300 ₽, стало 250 ₽» даёт сигнал на 300); `found: null` — сумма в тексте не выражается в единицах валюты.
- `checkShopA5(shop)` — `returns.text` против `returns.days`: срок цифрами в днях или сутках, отказ от возврата («не подлежат возврату», «без возврата») при `days` > 0. Срок словами («две недели») не распознаётся — сигнала нет.

Разбор линеен на любом тексте продавца: тест — 200 000 символов в worker за 2 с.

### Коннектор YML (К14)

`parseYml(input, profile, { exponent, offset?, limits? })` переводит фид YML (Яндекс.Маркет) в модель К8. Коннектор переводит формат, но не судит продавца: `validateShop`, `validateProduct` и A5 — отдельным вызовом.

```ts
import { parseYml, validateShop, validateProduct, checkProductA5 } from "@kuzin4u/agentic-core/catalog";

const { shop, products, issues } = parseYml(feedBuffer, profile, { exponent: 2, offset: "+03:00" });
// issues: [{ code: "YML_PRICE", path: "/yml_catalog/shop/offers/offer[2]/price" }] — предложение не переведено
// ошибка XML: shop = null, products = [], issues = [{ code: "XML_DOCTYPE", path: "@12" }] — смещение в символах
```

**Профиль магазина даёт потребитель.** ИНН, MCC, способов оплаты, регионов доставки и условий возврата в YML нет, а модель К8 их требует. `profile` — готовый `CatalogShop`: `id`, `inn` (10 или 12 цифр), `mcc`, `paymentMethods`, `deliveryRegions`, `returns`, по желанию `readiness`, `fulfillmentRating`. Коннектор переносит его в `shop` как есть, без проверки и без полей фида (`name`, `company`, `url` не читаются).

**Что читается.**
- `yml_catalog@date` → `updatedAt` всех товаров. Понимаются «2026-10-17 07:00», «…T07:00:00+0300», «…Z»; без пояса — `offset`, нет и его — `YML_DATE`, и ни одно предложение не переводится. С v0.11.0 (К20 п. 1) дата с поясом проверяется по календарю: «30 февраля», `24:00`, пояс `+1500` и `offset` вне ±14:00 (например `+15:00`) — тоже `YML_DATE`. Неверный по календарю `offset` замечается только у даты без своего пояса.
- `offer@id` → `sku`; `name` → `title`, для `type="vendor.model"` — `typePrefix vendor model`; `vendor` → `brand`, `model` → `model`, первый `barcode` → `gtin` (нет — `null`); `categoryId` → путь категории от корня через « / »; `description` — как есть, разметка из CDATA не очищается; `picture` → `images`; `param@name` (+ `@unit`) → `attributes`, при повторе имени остаётся первое; `count` → `quantity`.
- `available="false"` → `inStock: false`; без атрибута — `true`.
- Варианты `delivery-options`/`pickup-options` магазина действуют для всех предложений; такие же элементы предложения их заменяют; `<delivery>false</delivery>` или `<pickup>false</pickup>` убирают способ. `days`: «2» → 2…2, «1-3» → 1…3; `order-before` не читается; `region` у вариантов не ставится — во все регионы профиля.
- Прочие элементы и атрибуты пропускаются без ошибки.

**Цена и валюта (К9).** «250», «250.50», «250,50» → минимальные единицы по `exponent` потребителя — один на весь фид. Знаков после запятой больше `exponent`, знак, разряды через пробел, экспонента, больше `Number.MAX_SAFE_INTEGER` — `YML_PRICE`, без округления. `RUR` читается как `RUB`. `currencyId` должен быть среди `currencies`; если `currencies` нет — принимается любой код (проверит `validateProduct`). Курс `rate` не читается: стоимость доставки — в валюте цены предложения.

**Разборщик XML** — свой, без зависимостей, внутренний (из `/catalog` не экспортируется):
- DTD не исполняется. Короткий DOCTYPE без `[` пропускается: `<!DOCTYPE имя>`, `… SYSTEM "…">`, `… PUBLIC "…" "…">` (шапка `<!DOCTYPE yml_catalog SYSTEM "shops.dtd">`); внешний DTD не загружается никогда. С внутренним подмножеством, иной формы, длиннее 1 КиБ, повторный или после корня — `XML_DOCTYPE`. «Бомба» сущностей и XXE поэтому невозможны.
- Сущности — только `&lt; &gt; &amp; &quot; &apos;` и числовые ссылки на допустимые символы XML; любая другая, в том числе объявленная во внешнем DTD, и `&` без `;` — `XML_ENTITY`.
- Кодировка: `Buffer` — по объявлению, UTF-8 (по умолчанию, BOM допустим) или windows-1251; другая (KOI8-R, UTF-16) или неверная последовательность байт — `XML_ENCODING`, без замены символов. Строка считается уже декодированной, `encoding` в объявлении не читается.
- Пределы: `limits.maxBytes` (по умолчанию 64 МиБ, считается до декодирования), `limits.maxDepth` (64), не больше 256 атрибутов у элемента — иначе `XML_LIMIT`; неверный предел — `RangeError`.
- Символы вне XML 1.0 — C0, кроме табуляции, LF и CR; U+FFFE, U+FFFF; одиночные суррогаты — в тексте, атрибутах, CDATA и комментариях дают `XML_SYNTAX` со смещением (нулевой байт не примет PostgreSQL в `text`, управляющие символы попали бы в текст для модели агента). Проверка — до разбора, одним поиском по всему входу; числовая ссылка на такой символ (`&#1;`) — `XML_ENTITY`.
- Упрощения подмножества: имя элемента — латиница, цифры, `_ : - .` и любые символы от U+00C0; `--` внутри комментария не проверяется; инструкции обработки пропускаются. Перевод строки и табуляция в значении атрибута — пробел, ссылка `&#10;` сохраняется.
- Время разбора линейно: стек без рекурсии, поиск только внутри своего отрезка, пути категорий запоминаются. Тесты в worker с бюджетом 5 с времени процессора (с П2.1 сессии 15; раньше — стенные часы): 1 000 000 символов XML (≈ 0,75 с; квадратичная поломка — ≈ 57 с) и цепочка из 20 000 категорий на 20 000 предложений. У тестов линейности `/catalog` явный тайм-аут vitest 20 с (с v0.7.0): запуск worker и загрузка модулей идут вне бюджета, и под нагрузкой машины 5 с по умолчанию не хватало; бюджет разбора в worker — 5 с процессора (A5 — 2 с). Расход считает основной поток по `process.cpuUsage()` процесса vitest раз в 50 мс (`threadCpuUsage` в Node 20.19 нет) и останавливает worker при превышении; под нагрузкой worker получает меньше процессора, и ложного красного нет. Поломки «поиск `&` по всему входу» (XML) и «без кэша путей категорий» (YML) красные по бюджету процессора. Остаточный риск — тайм-аут vitest 20 с по часам при замедлении больше чем в ≈ 25 раз. Бюджет — процессор всего процесса тестов; это верно при `pool: forks` (по умолчанию в vitest 5: один файл тестов — один процесс), при `pool: threads` в счёт вошли бы соседние файлы.

**Коды** (`CatalogIssueCode`): `XML_SYNTAX`, `XML_ENTITY`, `XML_DOCTYPE`, `XML_ENCODING`, `XML_LIMIT` — путь `@смещение`; `YML_STRUCTURE` (корень не `yml_catalog` или нет `shop`, `offers`), `YML_DATE`, `YML_CURRENCY`, `YML_PRICE`, `YML_CATEGORY` (нет категории, разрыв или цикл `parentId`), `YML_NUMBER` (`count`, `days`), `REQUIRED` (`@id`, `name`, `price`, `@cost`) — путь в фиде. Ошибка предложения — оно не попадает в `products`; ошибка варианта доставки магазина — замечание, предложения переводятся без этого варианта.

### Живая проверка цены и наличия (К15)

Заказ по данным фида без живой проверки запрещён (К8 п. 5). Транспорт к продавцу (API продавца, ПАО, площадка) — у потребителя: он реализует порт `LiveOfferSource`; в ядре сети нет.

```ts
import { checkLiveOffer, type LiveOfferSource } from "@kuzin4u/agentic-core/catalog";

const source: LiveOfferSource = { fetch: (req, signal) => sellerApi.offer(req.sku, req.quantity, { signal }) };
const r = await checkLiveOffer(product, { sku: product.sku, quantity: 2, region: "77" }, source);
// { ok: true, offer } — можно начинать заказ; цену заказа всё равно считает продавец (инвариант 5)
// { ok: false, codes: ["LIVE_PRICE_UP"], offer } — заказ не начинать; offer — живое предложение для обновления позиции
```

- **Ответ** `LiveOffer { sku, price: Money, availability: { inStock, quantity? }, checkedAt }`; `checkedAt` — ISO 8601 с поясом.
- **Коды** (`LiveCheckCode`, каждый запрещает заказ):
  - `LIVE_UNAVAILABLE` — источник бросил, отклонил обещание или не ответил за `timeoutMs`;
  - `LIVE_INVALID` — ответ не по форме;
  - `LIVE_STALE` — ответ старше `maxAgeMs` или из будущего сверх `clockSkewMs`;
  - `LIVE_CURRENCY` — другая валюта;
  - `LIVE_PRICE_UP`, `LIVE_PRICE_DOWN` — цена выше или ниже каталога;
  - `LIVE_OUT_OF_STOCK` — нет в наличии;
  - `LIVE_QUANTITY` — продавец сообщил количество, и оно меньше запрошенного.

  При первых трёх кодах сравнение не выполняется, `offer` для `LIVE_UNAVAILABLE` и `LIVE_INVALID` — `null`.
- **Цена — строгое равенство** в минимальных единицах, допуска нет (К15 п. 4): отличие на одну единицу — уже код.
- **Параметры** `options`: `timeoutMs` (5000, не больше 2^31 − 1 — предел таймера Node), `maxAgeMs` (60 000), `clockSkewMs` (30 000), `now` (часы, мс). Границы включительно: ответ ровно `maxAgeMs` назад ещё свежий.
- **Отказ при неясности.** `ok: true` — только при полном совпадении. Исключение источника, геттер ответа, который бросает, часы, которые бросают или возвращают не число, — отказ (`LIVE_UNAVAILABLE` или `LIVE_INVALID`), а не разрешение. Повторов нет: один вызов `fetch` на проверку.
- **Ошибка вызова** — отклонённое обещание до обращения к источнику: `quantity` не целое ≥ 1, пустой `region`, `sku` товара не тот, что в запросе, цена товара не по К9, неверные `options`, у `source` нет `fetch`.
- **Ограничения:**
  - `region` передаётся источнику как есть, ответ по региону не сверяется: регион — забота источника;
  - по истечении `timeoutMs` вызывается `abort()` сигнала; если источник сигнал не слушает, его запрос продолжается, но поздний ответ результат не меняет;
  - стоимость и срок доставки живой проверкой не сверяются — только цена товара и наличие (К8 п. 5);
  - `offer` — копия ответа: изменение объекта источника после проверки результат не меняет.
  - дата `checkedAt` (и `updatedAt` в `validateProduct`) с v0.11.0 проверяется по календарю (К20 п. 1): месяц, день по месяцу и високосному году, час 00…23, минуты и секунды 00…59 (без `:60`), пояс не больше ±14:00; «30 февраля» и `T24:00` — ответ не по форме (`LIVE_INVALID`). До v0.11.0 их пропускал `Date.parse`, нормализуя.
- `compareLiveOffer(product, offer, req, options)` — то же сравнение синхронно, без сети, для ответа, полученного другим путём. Часы `now`, которые бросают или возвращают не число, здесь — ошибка вызова (исключение), а в `checkLiveOffer` — `LIVE_UNAVAILABLE`: источник там уже вызван, и результат должен быть кодом.

## Клиент ПАО: запрос без подписи (CO-1 агента, с v0.8.0)

`PaoClient` (`/pao`) у операции без подписи (`GET /.well-known/pao-configuration`) не отправляет заголовки агента: `x-agent-code`, `x-timestamp`, `x-nonce`, `content-digest`, `signature-input`, `signature`. Запрос открытой конфигурации не раскрывает, кто спрашивает. Так требует передача от агента (#31; PR #27 agentic-buyer-ref, Р33 п. 10). До v0.8.0 первые три заголовка уходили и с неподписанным запросом. Подписанные операции не меняются.

## Клиент ПАО: перенаправления и подписант (К18, с v0.9.0)

- **Перенаправлениям не следует.** `PaoClient` передаёт в `fetch` параметр `redirect: "manual"` для всех операций. Ответ 3xx, ответ `opaqueredirect` (браузер) и ответ с `redirected === true` дают отказ `PaoCallError` с `clientCode: "PAO_CLIENT_REDIRECT"`, без повтора. `inspectResponse` при этом не вызывается. Так подпись и тело не уходят на чужой хост, а конфигурацию нельзя подменить (#32).
  - **Нюанс.** Если свой `fetch` потребителя не учитывает `redirect` и сам проходит по перенаправлению, клиент это заметит по `redirected` и откажет, но запрос на чужой адрес к этому моменту уже ушёл. Свой `fetch` обязан передавать `redirect` дальше.
  - **Нюанс.** `status` у отказа — код 3xx в Node; в браузере у `opaqueredirect` он равен 0.
- **Код клиента.** Отказы самого клиента несут поле `clientCode` (`PaoClientCode`). Геттер `code` по-прежнему возвращает только коды ПАО (`ErrorCode`), так что `switch` по ним не ломается. Реестр — `PAO_CLIENT_DIAG` в формате `/diag`, `component: "core"`, действие `after_fix`; перечень кодов — `PAO_CLIENT_CODES`. Реестр `PAO_DIAG` не изменился: в нём ровно 20 кодов спецификации. Проверка полноты объединённого реестра: `checkDiagRegistry([...Object.keys(PAO_DIAG), ...PAO_CLIENT_CODES], { ...PAO_DIAG, ...PAO_CLIENT_DIAG })` → `[]`.
- **Подписант необязателен.** Без `signer` метод `call` по типам принимает только `PaoUnsignedOperationKey`; сейчас это `GET /.well-known/pao-configuration`, перечень строит генератор из спецификации. Вызов подписанной операции не компилируется. В JS или при приведении типов вызов отклоняется с `clientCode: "PAO_CLIENT_SIGNER_MISSING"` до запроса в сеть (`status: 0`, `attempts: 0`).
  - **Нюанс.** Клиент, собранный из переменной типа `PaoClientOptions`, по типам принимает все операции, потому что подписант там может быть. Тогда защищает только проверка во время выполнения.

## Реестр кодов отказов и отчёт самопроверки (К17, с v0.8.0)

Каждый код отказа описывается записью одного формата во всех трёх репозиториях. Формат — подмодуль `@kuzin4u/agentic-core/diag`, основной вход его не реэкспортирует. Реестр кодов ПАО — `PAO_DIAG` в `/pao`; платформа (PS-ДГ) подключает его, а не пишет свой.

```ts
import { checkDiagRegistry, diagAction, type DiagRegistry } from "@kuzin4u/agentic-core/diag";
import { PAO_DIAG } from "@kuzin4u/agentic-core/pao";

// тест полноты в репозитории потребителя: код без записи — красный
expect(checkDiagRegistry(MY_CODES, MY_REGISTRY)).toEqual([]);
// получатель кода: неизвестный код (новая версия соседа) — "stop"
const action = diagAction(PAO_DIAG, body.code);
```

- **Запись** `DiagEntry`, все поля обязательны:
  - `code` — `^[A-Z][A-Z0-9_]*$`, равен ключу в реестре;
  - `component` — кто выдаёт код: `core`, `pao`, `pi`, `platform`, `agent`;
  - `source` — кто ошибся: непустой массив из `agent`, `platform`, `bank`, `merchant`, `client`, `environment`, без повторов;
  - `action` — `stop`, `retry_same_key`, `after_fix`, `after_human`, `new_key`;
  - `human`, `operator` — тексты по языкам, `ru` обязателен;
  - `norm` — пункт норм или решение;
  - `since` — с какой версии действует.
- **`checkDiagRegistry(codes, registry, { langs })`** возвращает замечания кодами, без текста: `DIAG_MISSING`, `DIAG_EXTRA`, `DIAG_KEY_MISMATCH`, `DIAG_CODE_FORMAT`, `DIAG_ENUM`, `DIAG_EMPTY`. Языки `langs` (по умолчанию `["ru"]`) обязательны в обоих текстах; пустая строка на любом языке — `DIAG_EMPTY`. Повторы в `codes` не считаются ошибкой. Записи проверяются и тогда, когда пришли не из TypeScript.
- **`diagAction(registry, code)`** возвращает `action` записи. Код не из реестра, ключ из прототипа (`toString`) и действие вне перечня дают `stop`.
- **Тексты** — постоянные строки, без подстановок, персональных данных, путей с идентификаторами и бренда. В ответах и журналах передаётся только код, текст берётся из реестра в месте показа. Потребитель может показать свой текст поверх ядерного (например, с брендом), но `code`, `source` и `action` берёт из реестра ядра.
- **`PAO_DIAG`** — 20 записей, по одной на код `ErrorCode` ПАО 1.4.0; тип `Record<ErrorCode, DiagEntry>`, поэтому пропуск кода не соберётся и в TypeScript.
  - `action` равен `PAO_RETRY_ACTION[PAO_ERRORS[code].retry]`, тест сверяет каждую запись.
  - `since` — `1.1.0`; у `REQUEST_INVALID` и `KEY_INVALID` — `1.3.0` (К11).
  - **Нюанс.** Действия в стартовой таблице документа владельца от 18.10 местами расходятся с `retry` в `x-pao-errors`. В реестре стоит значение спецификации:
    - `SIGNATURE_INVALID`, `IDEMPOTENCY_CONFLICT`, `KEY_INVALID` — `after_fix`;
    - `AGENT_SUSPENDED` — `stop`;
    - `MANDATE_EXPIRED` — `after_human`;
    - `IDEMPOTENCY_REQUIRED` — `retry_same_key`.

    Уточнения агента (у `KEY_INVALID` — новый ключ, не больше 3 раз подряд) записаны в текст для оператора и в реестр агента. Новых значений действия они не создают.
  - `source` — по документу владельца. Для кодов, которых в нём нет, — решение владельца в PR #30: `AGENT_UNKNOWN`, `AGENT_KEY_REVOKED`, `CREDENTIALS_FORBIDDEN`, `RATE_LIMITED` — `agent`; `CREDENTIAL_INVALID` — `agent`, `bank`; `LIMIT_EXCEEDED` — `client`, `bank`; `CONFIRMATION_REQUIRED` — `client`.
  - `norm` — у кодов без отдельного решения стоит `AGENT-PROTOCOL §6 (РП16)`.
- **`CATALOG_DIAG`** (`/catalog`) — 32 записи: 22 кода `CatalogIssueCode` (валидатор, `XML_*`, `YML_*`), 2 кода `A5SignalCode`, 8 кодов `LiveCheckCode`. Тип `Record<CatalogDiagCode, DiagEntry>`: пропуск кода не соберётся. Перечни кодов — `CATALOG_ISSUE_CODES`, `A5_SIGNAL_CODES`, `LIVE_CHECK_CODES`, все вместе — `CATALOG_DIAG_CODES`; тест полноты у потребителя — `checkDiagRegistry(CATALOG_DIAG_CODES, CATALOG_DIAG)`.
  - `component: "core"`, `since: "0.6.0"` — все коды появились в v0.6.0 (К8, К14, К15).
  - `source` — `merchant` (первая оценка документа владельца); у `LIVE_UNAVAILABLE` — `merchant`, `environment`: тайм-аут и сеть от продавца не отличить.
  - `action`: ошибки фида и сигналы A5 — `after_fix` (исправляет продавец); `LIVE_UNAVAILABLE`, `LIVE_STALE` — `retry_same_key` (повтор проверки — решение потребителя, в ядре повторов нет, К15 п. 5); `LIVE_INVALID`, `LIVE_CURRENCY` — `stop` (ответ продавца негоден, вызывающий его не исправит); `LIVE_PRICE_UP`, `LIVE_PRICE_DOWN`, `LIVE_QUANTITY` — `after_human` («новая корзина» после согласия покупателя — в тексте для оператора, К17 п. 2; К15 п. 4); `LIVE_OUT_OF_STOCK` — `stop`. Решение владельца 19.10 (PR #30); стартовая таблица документа владельца (`stop` у шести кодов, «новая корзина» у цены) расходится — документ поправит чат.
  - **Нюанс.** Коды валидатора общие по имени (`REQUIRED`, `BAD_AMOUNT`, `BAD_CURRENCY`): `BAD_AMOUNT` и `BAD_CURRENCY` есть и у `MoneyError`, `HoldError` основного входа, но те в реестры не входят. С `PAO_DIAG` общих кодов нет — объединённый реестр `{ ...PAO_DIAG, ...CATALOG_DIAG }` записей не теряет (тест). Реестр потребителя, объединяемый с ядерными, должен проверять то же.
- **Отчёт самопроверки (К17 п. 8)** — общий формат для старта платформы и агента: `SelfCheckReport { component, version, checked_at, ready, checks }`, проверка `SelfCheckItem { check, status: "ok" | "warn" | "fail", code? }`.
  - `buildSelfCheckReport(component, version, checks, now = new Date())` сам считает `ready` (нет ни одного `fail`; `warn` готовность не снимает), `checked_at` — `now.toISOString()`. Вход не проверяет.
  - `checkSelfCheckReport(report, registry)` — замечания `{ code, check?, field? }`: `SELFCHECK_EMPTY`, `SELFCHECK_FIELD`, `SELFCHECK_CHECK_FORMAT` (`^[a-z][a-z0-9_.]*$`), `SELFCHECK_DUPLICATE`, `SELFCHECK_CODE_MISSING` (`warn`/`fail` без кода), `SELFCHECK_CODE_FORBIDDEN` (код при `ok`), `SELFCHECK_CODE_UNKNOWN`, `SELFCHECK_READY_MISMATCH`. Пустой массив — отчёт корректен.
  - Реестр — свой или объединённый с ядерным (`{ ...PLATFORM_DIAG, ...PAO_DIAG }`); `component` записей с `component` отчёта не сверяется. Ключ из прототипа (`toString`) — `SELFCHECK_CODE_UNKNOWN`.
  - **Нюанс.** `checked_at` — форма `YYYY-MM-DDTHH:MM:SS[.sss]Z` и календарь (с v0.11.0, К20 п. 1): «30 февраля», 29 февраля невисокосного года, `T24:00`, `:60` — замечание `SELFCHECK_FIELD`. Смещение `+03:00` и дробь не из трёх цифр — замечание.
  - Свободного текста в отчёте нет: тексты человеку и оператору — из реестра по `code` в месте показа. Коды самопроверки ведёт каждый компонент в своём реестре; у ядра их нет. При `ready: false` компонент не принимает рабочий трафик, пишет отчёт одной строкой JSON и завершает запуск с ненулевым кодом — норма формата, исполняет потребитель. Отдача отчёта по сети — ПАО 1.5.0.

## Матрица испытаний и эмулятор ситуаций (К19, с v0.10.0)

Каждая развилка реестра чата (РЗ-N = Р-N реестра) и каждый конфликт пула (КП-N = К-N в `29-konflikty.html` платформы) попадают в тестовый контур: покрыты ситуацией или вынесены «вне испытаний» с основанием. Подмодуль `@kuzin4u/agentic-core/trials`, основной вход его не реэкспортирует. Ядро даёт формат, движок, полноту и реестр; ситуации и стенд — в репозитории своего решения, сквозные — у агента против стенда платформы.

```ts
import { checkSituations, checkCoverage, runTrials, trialScope, formatTrialFailure, TRIAL_UNSUPPORTED,
  type TrialSituation, type TrialStand, type TrialExclusion } from "@kuzin4u/agentic-core/trials";

const SITUATIONS: TrialSituation[] = [{
  id: "КП-8.цена", refs: ["КП-8"], params: { delta: [-1, 0, 1] },
  expect: [{ when: { delta: [0] }, outcome: { ok: true } }, { outcome: { ok: false } }],
  rejected: [{ variant: "коридор", note: "КП-8: допуск в пределах коридора" }],
}];
const stand: TrialStand = { async run({ situation, params, variant, signal }) { /* свои вызовы */ return TRIAL_UNSUPPORTED; } };
const EXCLUSIONS: TrialExclusion[] = [{ ref: "КП-11", basis: "process", reason: "экономика схемы, не код", recordedIn: "PS-…" }];

expect(checkSituations(SITUATIONS)).toEqual([]);
expect(checkCoverage({ scope: trialScope("agentic-ps-platform"), situations: SITUATIONS, exclusions: EXCLUSIONS })).toEqual([]);
const report = await runTrials(stand, SITUATIONS, { mode: "grid" });       // или { mode: "sample", n, seed }
expect(report.failures.map(formatTrialFailure)).toEqual([]);
```

- **Ситуация** — только данные: `refs` (`РЗ-N` / `КП-N`), `params` (`{ имя: [значения JSON] }`), `exclude` (частичные наборы), `expect` (первое правило, чьи `when` подходят), `rejected` (отклонённые варианты для стенда) или `rejectedNone` с основанием. Исход сравнивается по подмножеству ключей через `canonicalJson`: служебные поля стенда (время, идентификаторы) не мешают.
- **Стенд** `TrialStand.run({ situation, refs, key, params, variant, signal })` — у потребителя; `variant` — `"chosen"` или имя отклонённого. Чистое состояние на каждый случай — забота стенда. Не умеет — `TRIAL_UNSUPPORTED` (`Symbol.for`, совпадает у двух копий пакета).
- **Сетка и выборка.** `mode: "grid"` — все сочетания, больше `maxCases` (1000) — `TRIALS_GRID_TOO_LARGE`. `mode: "sample"` — `n` разных номеров, mulberry32 от обязательного `seed` (uint32). Ключ случая — `<id>#<номер в сетке>`, от зерна не зависит: `replayCase(stand, situation, key)` повторяет один случай.
- **Отклонённый вариант обязан провалиться:** при `must: "any"` (по умолчанию) — разойтись с ожидаемым хотя бы на одном случае, при `"all"` — на каждом. Иначе `TRIALS_REJECTED_PASSED`: испытание не различает решения. Стенд не умеет вариант — `TRIALS_REJECTED_UNSUPPORTED`; это провал, а не пропуск.
- **Полнота** `checkCoverage({ scope, situations, exclusions })`: пункт своей области покрыт или «вне испытаний» (`legal`, `pilot`, `external`, `process`; `reason` и `recordedIn` непусты), не то и другое сразу. Чужие пункты покрывать можно. Каждый пункт реестра назначен ровно одному репозиторию (`TRIAL_REPOS`), поэтому зелёная полнота в каждом — покрыто всё. Области: `agentic-core` 20, `agentic-ps-platform` 47, `agentic-buyer-ref` 29.
- **Реестр** — `TRIAL_FORKS` (Р-1…Р-86, с v0.11.0), `TRIAL_CONFLICTS` (К1…К20), `TRIAL_ITEMS` (со ссылками РЗ/КП). Источники и хэши — `src/trials/registry/SOURCE.md`; `npm run gen:trials` строит `src/trials/registry.ts`, тест сверяет `--check`. Обновление развилок — новым комментарием чата в PR: копия через `gh api` побайтно, без правки руками.
- Коды `TRIALS_*` (`TRIALS_CODES`) — без текстов и не в реестре `/diag`: это проверки каталога и прогона, а не отказы обмена. `formatTrialFailure` — одна техническая строка с ключом для повтора.
- **Нюансы.**
  - Ключи параметров нумеруются в порядке `canonicalJson` — `sort()` по единицам UTF-16; от порядка по кодовым точкам он отличается только для символов вне BMP. Первый ключ — старший разряд. Изменили ситуацию (значения, порядок) — номера случаев сдвинулись: для повтора старого случая передайте `params` из отчёта в `replayCase`.
  - Выборка может не взять различающий случай — тогда `TRIALS_REJECTED_PASSED` при `any`. Это сигнал: добавьте различающее значение или берите сетку.
  - Исключённые сочетания при выборке тянутся заново, не более `64·n + 1024` попыток: если исключено почти всё, случаев меньше `n` — число случаев в отчёте.
  - `checkSituations` перебирает сетку на «сочетание без правила» только до 10 000 сочетаний (`CHECK_ENUMERATE_LIMIT`); больше — поймает прогон (`TRIALS_NO_EXPECT`).
  - Отклонённые варианты прогоняются только по случаям с ожидаемым исходом.
  - Предел времени (`timeoutMs`, 10 000) не останавливает стенд, а отменяет `signal`; стенд, который его не слушает, продолжает работать в фоне.
  - `TRIALS_ID_DUPLICATE` — также пустой `id` и `id` с `#`; `TRIALS_PARAMS_EMPTY` — также значение не JSON.
- Каталог ядра — `tests/trials/core-catalog.ts`: 15 ситуаций на 16 своих пунктов (из 24) против настоящего кода (диагностика, клиент ПАО, A5, живая проверка цены; с v0.11.0 — РЗ-77…РЗ-80 против самого движка `/trials` на внутренней ситуации: сравнение по подмножеству, воспроизведение по ключу, неумение стенда, назначение пункта одному репозиторию), отклонённые варианты эмулированы поверх кода; 8 процессных развилок — `process`. РЗ-4 с v0.11.0 (К20) ждёт календарную проверку `checked_at`, отклонённый вариант — «только формат» (шаблон и `Date.parse`, как до v0.11.0) — обязан провалиться.
