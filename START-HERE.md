# Запуск agentic-core

Этот репозиторий создаётся первым: от него зависят три других.

```bash
cd ~/repos && git clone https://github.com/<аккаунт>/agentic-core.git && cd agentic-core
git checkout -b claude-setup
cp -R ~/Downloads/<архив>/agentic-core/. .
npm install && npm test   # 11 тестов
git add -A && git commit -m "agentic-core v0.1.0"
```

PR в main, слияние, затем на main: `git tag v0.1.0 && git push origin v0.1.0`.

---

# Модульный комплект: порядок действий

В архиве пять папок:

| Папка | Что это | Действие |
|---|---|---|
| `ecosystem-modules/` | `MODULES.md` (модульная карта) и `repo-notes/` (решения для существующих репозиториев) | положить в репозиторий `ecosystem-docs` |
| `agentic-core/` | Новый репозиторий: общий пакет, код v0.1.0, 11 тестов, векторы | создать первым, поставить тег `v0.1.0` |
| `agentic-ps-platform/` | Обновлён: РП13–РП15, условное исполнение `/cx/v1`, ПАО v1.1.0, 28 сценариев, зависимость от agentic-core | заменить ранее выданный комплект |
| `nsvr-settlement/` | Новый репозиторий: расчётный контур НСВР, BankAdapter `reserve / commit / release`, 14 сценариев | создать |
| `agentic-buyer-ref/` | Обновлён: Р15–Р17 (ядро без модели, порт Advisor, адаптер nsvr), зависимость от agentic-core | заменить ранее выданный комплект |

## Порядок

1. `agentic-core`: репозиторий → распаковать → `npm install && npm test` (11 тестов) → коммит → тег `v0.1.0` → push тега (`git push origin v0.1.0` делаете вы).
2. Только после этого — `agentic-ps-platform`, `nsvr-settlement`, `agentic-buyer-ref`: их `package.json` ссылается на `git+https://github.com/kuzin4u/agentic-core.git#v0.1.0`, без тега CI не соберётся.
3. Записи из `repo-notes/` — в сессиях соответствующих репозиториев через `/decision`.
4. В каждом новом репозитории — `/start`.

Репозитории открытые (решение 08.10.2026). Если agentic-core станет закрытым, CI других репозиториев получит к нему доступ через токен с правом чтения (секрет GitHub Actions) — это одна настройка в каждом зависимом репозитории.
