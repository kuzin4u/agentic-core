# Состояние agentic-core

**Версия:** 0.1.0. **Тесты:** 11 из 11. **Векторы:** canonical 3, journal 2, holds 10 шагов.

## Следующая сессия
`/start` → `/task К-0.2 Хранилища PostgreSQL для journal и holds` — с тестом конкурентности на реальной базе (docker compose).

## Потребители
| Проект | Версия | Что использует |
|---|---|---|
| agentic-ps-platform | 0.1.0 (план) | journal, holds, idempotency, signing, events |
| agentic-buyer-ref | 0.1.0 (план) | signing, idempotency, events, journal |
| nsvr-settlement | 0.1.0 (план) | holds, journal, events, money, idempotency |
| marketplace-api | 0.1.0 (план) | journal (ст. 15), money (сплит), signing (агентский слой) |

## Расхождения
—
