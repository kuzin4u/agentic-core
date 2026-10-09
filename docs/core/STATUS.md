# Состояние agentic-core

**Версия:** 0.1.0. **Тесты:** 11 из 11. **Векторы:** canonical 3, journal 2, holds 10 шагов.

## Следующая сессия
`/start` → `/task CO-3 Типы и клиент ПАО, тег v0.2.0` — типы ПАО v1.1, генерируемые из `agent-protocol.yaml` платформы; клиент ПАО с подписью и повторами по полю `retry`; сервер-заглушка для контрактных тестов.

Порядок — по [`../reference/joint-plan.md`](../reference/joint-plan.md): CO-3 нужна платформе (PS-02) и агенту (AG-02) первой. Хранилища PostgreSQL идут позже — CO-1 (журнал) и CO-2 (удержания, идемпотентность, nonce; тег v0.3.0), к PS-05, PS-06 и PS-09.

## Потребители
| Проект | Версия | Что использует |
|---|---|---|
| agentic-ps-platform | 0.1.0 (план) | journal, holds, idempotency, signing, events |
| agentic-buyer-ref | 0.1.0 (план) | signing, idempotency, events, journal |
| nsvr-settlement | 0.1.0 (план) | holds, journal, events, money, idempotency |
| marketplace-api | 0.1.0 (план) | journal (ст. 15), money (сплит), signing (агентский слой) |

## Расхождения

| № | Где | Суть | Предложение | Статус |
|---|---|---|---|---|
| 1 | `package.json`; потребители по К4 | Нет скрипта `prepare`, `dist/` в `.gitignore`: при установке `git+…#v0.1.0` в agentic-ps-platform и agentic-buyer-ref приходит пакет без `dist/`, `main` и `exports` указывают в пустоту. Пока не проявилось — импортов пакета у потребителей нет; PS-02 и AG-02 упрутся первыми | `"prepare": "tsc"` (сборка при установке из git) до тега v0.2.0; проверка в CI — установка упакованного архива и импорт `.` и `/pao` | новое |
| 2 | AGENT-PROTOCOL.md §6 (платформа) | `retry` неоднозначен: `new_key` стоит только у `AGENT_KEY_REVOKED` (новый ключ подписи, не `Idempotency-Key`); `same_key` — только у `IDEMPOTENCY_REQUIRED`; временные `RATE_LIMITED`, `STATE_UNAVAILABLE`, `UPSTREAM_UNAVAILABLE` помечены `after_fix`. Клиент CO-3 сделан по решению владельца от 09.10.2026: `same_key` — автоповтор с тем же ключом; сеть и 429/503 с `Retry-After` — повтор с тем же ключом; остальное — вызывающему | В платформе — решение РП: определить `same_key`/`new_key` в §6 явно; 429/503 с `Retry-After` → `same_key`. После правки — `/decision` здесь и правка клиента | новое |
| 3 | AGENT-PROTOCOL.md §2 (платформа) | `content-digest` подписывается всегда, у GET тела нет. Клиент CO-3 подписывает digest пустой строки (решение владельца от 09.10.2026) | Дописать в §2: «у запросов без тела — digest пустого тела» | новое |
| 4 | `agent-protocol.yaml` против AGENT-PROTOCOL.md §6 | HTTP-статус и `retry` по кодам есть только в Markdown; в YAML их нет, заглушка держит ручную копию таблицы (сейчас совпадает: 18 из 18, перечень `ErrorCode` совпадает) | Перенести таблицу в YAML (`x-pao-errors`) — тогда генератор возьмёт её, ручной копии не будет | новое |
| 5 | AGENT-PROTOCOL.md §2 | Проверка `Platform-Signature` ответов и событий в CO-3 не вошла (решение владельца); в клиенте — точка расширения `inspectResponse` | Сделать вместе с ключами Платформы (SEC-1, PS-05) | новое |
| 6 | ROADMAP 0.2 против joint-plan CO-3 | Оценка: 4 ч в ROADMAP, 1 сессия (~3 ч) в совместном плане | Привести к одному значению при `/finish` | новое |
| 7 | `.claude/commands` (`/verify`, `/decision`) | Шаблоны команд взяты из платформы: ссылаются на SPEC.md, ФП1–ФП16, `src/shared`, `scenarios.json`, `params.stand.json`, РП — в agentic-core их нет | Переписать под agentic-core: К-решения, модули, векторы, `spec/`, `/pao` | новое |
