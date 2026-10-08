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
—
