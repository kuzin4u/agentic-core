# agentic-core

Общие механизмы агентной коммерции и расчётов: каноническая сериализация, журнал с хэш-цепочкой, удержания (резерв → закрепление → освобождение), идемпотентность, подпись HTTP-обращений, доставка событий, суммы в минимальных единицах с валютой. Без внешних зависимостей во время выполнения.

```
npm install
npm test
```

Подключение: `"@kuzin4u/agentic-core": "git+https://github.com/kuzin4u/agentic-core.git#v0.5.0"` (после тега; переход с 0.4.x, 0.3.x и 0.2.x — [`CHANGELOG.md`](CHANGELOG.md), раздел «Переход»). Типы, клиент и сервер-заглушка ПАО — `import … from "@kuzin4u/agentic-core/pao"` (К5). Каталог продавца — `import … from "@kuzin4u/agentic-core/catalog"` (К8, с v0.6.0). Правила и состав — [`CLAUDE.md`](CLAUDE.md).

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

Подмодуль `/catalog` — каноническая модель каталога: агент читает каталоги только в ней, формат продавца переводит коннектор. Основной вход её не реэкспортирует.

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
- `yml_catalog@date` → `updatedAt` всех товаров. Понимаются «2026-10-17 07:00», «…T07:00:00+0300», «…Z»; без пояса — `offset`, нет и его — `YML_DATE`, и ни одно предложение не переводится.
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
- Время разбора линейно: стек без рекурсии, поиск только внутри своего отрезка, пути категорий запоминаются. Тесты в worker с бюджетом 5 с: 1 000 000 символов XML (≈ 0,8 с; квадратичная поломка — ≈ 57 с) и цепочка из 20 000 категорий на 20 000 предложений.

**Коды** (`CatalogIssueCode`): `XML_SYNTAX`, `XML_ENTITY`, `XML_DOCTYPE`, `XML_ENCODING`, `XML_LIMIT` — путь `@смещение`; `YML_STRUCTURE` (корень не `yml_catalog` или нет `shop`, `offers`), `YML_DATE`, `YML_CURRENCY`, `YML_PRICE`, `YML_CATEGORY` (нет категории, разрыв или цикл `parentId`), `YML_NUMBER` (`count`, `days`), `REQUIRED` (`@id`, `name`, `price`, `@cost`) — путь в фиде. Ошибка предложения — оно не попадает в `products`; ошибка варианта доставки магазина — замечание, предложения переводятся без этого варианта.
