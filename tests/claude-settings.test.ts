// .claude/settings.json (К21, К28; РП68 платформы, п. 4 и дополнения 2–3): заранее разрешено только чтение,
// изменяющие команды — с вопросом, слияние PR — запрет, auto mode выключен (disableAutoMode). Порядок Claude Code:
// deny → ask → allow, списки файлов настроек складываются — ask проектного файла перекрывает allow из
// settings.local.json. Страж guard.py подключён к PreToolUse. SETTINGS_PATH — путь к проверяемой копии (поломки по С3).
//
// Состав allow у ядра свой: побайтно с платформой settings.json не сверяется (у ядра свои deny — .env, *.pem, *.key,
// docs/reference/**), поэтому расхождение в allow ловит только этот тест (К28 п. 4).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Hook = { matcher?: string; hooks: { type: string; command: string }[] };
type Settings = {
  disableAutoMode?: string;
  permissions: { allow: string[]; ask: string[]; deny: string[] };
  hooks: Record<string, Hook[]>;
};

const PATH = process.env.SETTINGS_PATH ?? join(process.cwd(), ".claude/settings.json");
const settings = JSON.parse(readFileSync(PATH, "utf8")) as Settings;
const { allow, ask, deny } = settings.permissions;

const READ_ONLY = [
  // К21 (передача #42, РП68 п. 4): тесты через стража С1.
  "Bash(git status)",
  "Bash(git status:*)",
  "Bash(git log)",
  "Bash(git log:*)",
  "Bash(git diff)",
  "Bash(git diff:*)",
  "Bash(git show)",
  "Bash(git show:*)",
  "Bash(gh pr checks:*)",
  "Bash(gh pr view:*)",
  "Bash(npm test)",
  "Bash(npm test:*)",
  "Bash(npx vitest run:*)",
  // К28 (передача #48, Р-1249, Р-1317 (б) платформы): безопасное чтение — команды не пишут файлы и не меняют состояние.
  "Bash(git describe:*)",
  "Bash(git rev-parse:*)",
  "Bash(gh issue view:*)",
  "Bash(gh issue list:*)",
  "Bash(gh label list:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh run view:*)",
  "Bash(gh run list:*)",
  "Bash(uptime)",
  // К28 (Р-1322, бывший Р-1319): инструмента Grep в сессии может не быть — поиск по содержимому grep и cut в Bash
  // (сами файлы не пишут; запись через > — остаточный риск К28 п. 1, строка в STATUS «Открыто»).
  "Bash(grep:*)",
  "Bash(cut:*)",
];

// К28 п. 3: заранее не разрешать. gh api — префикс не ограничивает метод (-X DELETE); sed — команда w пишет файл;
// awk — print > файл и system(); find — -delete и -exec; base64 — -o; python3 и node — интерпретаторы; echo и
// printf — запись через >. git -C — правило сопоставляется по началу команды, git -C <путь> commit прошёл бы мимо
// Bash(git commit:*) из ask (нюанс (д) РП68 дополнения 2).
const NOT_ALLOWED = /^Bash\((gh api|sed|awk|find|base64|python3?|node|echo|printf|git -C)\b/;

const ASK = [
  "Bash(git commit:*)",
  "Bash(git push:*)",
  "Bash(git revert:*)",
  "Bash(gh pr create:*)",
  "Bash(git checkout:*)",
  "Bash(git restore:*)",
  "Bash(git reset:*)",
  "Bash(git pull:*)",
  "Bash(npm install:*)",
  "Bash(npm i:*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
];

// Защита документов и секретов — своя у ядра, побайтной копии настроек платформы нет (К28, отклонённый вариант).
const DENY = [
  "Bash(gh pr merge:*)",
  "Bash(git reset --hard:*)",
  "Read(./.env)",
  "Read(./**/*.pem)",
  "Read(./**/*.key)",
  "Edit(./docs/reference/**)",
];

describe(".claude/settings.json: только чтение без вопроса, auto mode выключен", () => {
  it("auto mode выключен", () => {
    expect(settings.disableAutoMode).toBe("disable");
  });

  it("allow — ровно список только для чтения", () => {
    expect([...allow].sort()).toEqual([...READ_ONLY].sort());
  });

  it.each(ASK)("ask: %s", (rule) => {
    expect(ask).toContain(rule);
  });

  it.each(DENY)("deny: %s", (rule) => {
    expect(deny).toContain(rule);
  });

  it("изменяющие команды не разрешены заранее", () => {
    const changing =
      /^Bash\((git (commit|push|revert|checkout|restore|reset|pull|add|merge|rebase|tag)|gh pr (create|merge|ready|edit|comment)|npm (install|i|ci))\b/;
    expect(allow.filter((r) => changing.test(r))).toEqual([]);
    expect(allow.filter((r) => !r.startsWith("Bash("))).toEqual([]);
  });

  it("пишущие или неограниченные по методу команды не разрешены заранее (К28 п. 3)", () => {
    expect(allow.filter((r) => NOT_ALLOWED.test(r))).toEqual([]);
  });

  it("страж guard.py подключён к PreToolUse для Bash, Write, Edit, MultiEdit, Read", () => {
    const guard = (settings.hooks.PreToolUse ?? []).find((h) =>
      h.hooks.some((x) => x.command.includes(".claude/hooks/guard.py")),
    );
    expect(guard).toBeDefined();
    expect((guard?.matcher ?? "").split("|").sort()).toEqual(["Bash", "Edit", "MultiEdit", "Read", "Write"]);
  });
});
