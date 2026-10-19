// Генератор реестра испытаний (К19 п. 5): src/trials/registry/{forks,conflicts}.json → src/trials/registry.ts.
// `node scripts/gen-trials.mjs` — записать; `--check` — сверить с файлом и хэшами в src/trials/registry/SOURCE.md, не записывая.
// Отказ — при неизвестном поле, поле не того типа, повторе id, неизвестном repo, count не равном длине: список возвращается
// источнику (чату или пулу), руками не правится.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const DIR = "src/trials/registry";
const SOURCE = `${DIR}/SOURCE.md`;
const OUT = "src/trials/registry.ts";
const REPOS = ["agentic-core", "agentic-ps-platform", "agentic-buyer-ref", "nsvr-settlement", "marketplace-api"];

const str = (v) => typeof v === "string" && v.trim() !== "";
const FORK = { id: (v) => typeof v === "string" && /^Р-[1-9][0-9]*$/.test(v), question: str, chosen: str, rejected: str, decided_by: str, review: (v) => v === null || str(v), recorded_in: str, repo: (v) => REPOS.includes(v) };
const CONFLICT = { id: (v) => typeof v === "string" && /^К[1-9][0-9]*$/.test(v), title: str, stage: (v) => Number.isSafeInteger(v) && v >= 0, status: str, parties: str, repo: (v) => REPOS.includes(v) };

function load(file, listKey, shape, top) {
  const raw = readFileSync(`${DIR}/${file}`);
  const sha = createHash("sha256").update(raw).digest("hex");
  const doc = JSON.parse(raw.toString("utf8"));
  const fail = (m) => { throw new Error(`${file}: ${m}`); };
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) fail("TOP");
  for (const k of Object.keys(doc)) if (![...top, "count", listKey].includes(k)) fail(`UNKNOWN_FIELD ${k}`);
  const list = doc[listKey];
  if (!Array.isArray(list)) fail(`NOT_LIST ${listKey}`);
  if (doc.count !== list.length) fail(`COUNT ${doc.count} != ${list.length}`);
  const ids = new Set();
  list.forEach((e, i) => {
    if (typeof e !== "object" || e === null || Array.isArray(e)) fail(`ENTRY ${i}`);
    for (const k of Object.keys(e)) if (!Object.hasOwn(shape, k)) fail(`UNKNOWN_FIELD ${i}.${k}`);
    for (const [k, ok] of Object.entries(shape)) if (!Object.hasOwn(e, k) || !ok(e[k])) fail(`FIELD ${e.id ?? i}.${k}`);
    if (ids.has(e.id)) fail(`DUPLICATE ${e.id}`);
    ids.add(e.id);
  });
  return { sha, list };
}

const forks = load("forks.json", "forks", FORK, ["source", "exported"]);
const conflicts = load("conflicts.json", "conflicts", CONFLICT, ["source"]);

const lit = (list) => "[\n" + list.map((e) => "  " + JSON.stringify(e)).join(",\n") + ",\n]";
const out = `// Сгенерировано scripts/gen-trials.mjs из src/trials/registry/*.json (К19 п. 5) — не править.
import type { TrialConflict, TrialFork } from "./types.js";

export const TRIAL_FORKS_SHA256 = "${forks.sha}";
export const TRIAL_CONFLICTS_SHA256 = "${conflicts.sha}";

export const TRIAL_FORKS: readonly TrialFork[] = ${lit(forks.list)};

export const TRIAL_CONFLICTS: readonly TrialConflict[] = ${lit(conflicts.list)};
`;

if (process.argv.includes("--check")) {
  const source = readFileSync(SOURCE, "utf8");
  for (const [name, sha] of [["forks.json", forks.sha], ["conflicts.json", conflicts.sha]]) {
    if (!source.includes(sha)) { console.error(`${SOURCE}: нет sha-256 ${name} ${sha}`); process.exit(1); }
  }
  if (readFileSync(OUT, "utf8") !== out) { console.error(`${OUT} устарел: npm run gen:trials`); process.exit(1); }
} else {
  writeFileSync(OUT, out);
}
