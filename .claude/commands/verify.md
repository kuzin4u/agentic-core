---
description: Сверка документов с кодом; расхождения — в STATUS
argument-hint: [модуль или раздел; по умолчанию — всё]
---
Сверка: $ARGUMENTS

1. Модули: таблица «Модули» в `CLAUDE.md` против экспортов `src/index.ts` и `src/pao/index.ts` — каждый модуль есть и экспортирован; в основном входе нет имён ПАО (К5).
2. Решения: `docs/core/DECISIONS.md` (К-записи) против кода — нейтральные имена в API основного входа (К2: нет «мандат», «сделка», «эскроу», «заказ»); ПАО только в `/pao` (К5); `retry` и таблица ошибок — по К7.
3. Векторы (К3): `npm run vectors`, затем `git diff --stat vectors/` — пусто. Если файл изменился — верни `git checkout vectors/vectors.json` и запиши расхождение: векторы меняются только через `/decision`.
4. Спецификация ПАО: `npm run gen:pao -- --check` — копия `spec/agent-protocol.yaml` совпадает с хэшем в `spec/SOURCE.md` и с `src/pao/types.ts`.
5. Зависимости: поле `dependencies` в `package.json` пусто; в `src/` импортируются только модули `node:` и свои файлы. Драйверы и инструменты — только в `devDependencies`.
6. Версия: `package.json`, `package-lock.json`, строка подключения в `README.md`, шапка `STATUS.md` и последний тег на `origin` (`git ls-remote --tags origin`) согласованы; тег версии с `main` — на коммите слияния.
7. Потребители: версия `@kuzin4u/agentic-core` в `../agentic-ps-platform/package.json`, `../agentic-buyer-ref/package.json` (и других рядом, если есть) против таблицы «Потребители» в STATUS.
8. Документы: ссылки в `docs/core/INDEX.md`, ROADMAP (сделанные этапы отмечены), `.claude/commands` — только на существующие файлы.
9. Расхождения запиши в `docs/core/STATUS.md`, раздел «Расхождения» (№ · где · суть · предложение · статус «новое»). Документы и код не правь.
10. Итог: таблица по пунктам 1–8 — сходится · расходится (№ расхождения).
