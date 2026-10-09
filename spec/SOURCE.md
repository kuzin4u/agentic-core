# Источник спецификации ПАО

| Файл | Источник | Коммит | sha-256 |
|---|---|---|---|
| `agent-protocol.yaml` (ПАО 1.1.0) | agentic-ps-platform, `docs/core/agent-protocol.yaml` | `0bc924e` | `e6725aa4270155be5d0606cb366ca095fedc13a7d4e6c7b9500d25addf945ecb` |

Копия не правится вручную. Обновление — через `/decision` (К5): скопировать файл из платформы, обновить эту таблицу, `npm run gen:pao`. Тест сверяет хэш копии с этой таблицей и с заголовком `src/pao/types.ts`.
