import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Hex } from "../src/canonical.js";
import { TRIAL_FORKS, TRIAL_CONFLICTS, TRIAL_FORKS_SHA256, TRIAL_CONFLICTS_SHA256, TRIAL_REPOS } from "../src/trials/index.js";

const DIR = "src/trials/registry";

/** Прогон генератора на копии реестра с правкой `edit` одного файла: код выхода и сообщение. */
function genOn(file: string, edit: (doc: any) => void): string {
  const tmp = mkdtempSync(join(tmpdir(), "gen-trials-"));
  mkdirSync(join(tmp, "src/trials"), { recursive: true });
  mkdirSync(join(tmp, "scripts"));
  cpSync(DIR, join(tmp, DIR), { recursive: true });
  cpSync("scripts/gen-trials.mjs", join(tmp, "scripts/gen-trials.mjs"));
  const doc = JSON.parse(readFileSync(join(tmp, DIR, file), "utf8"));
  edit(doc);
  writeFileSync(join(tmp, DIR, file), JSON.stringify(doc));
  try {
    execFileSync(process.execPath, ["scripts/gen-trials.mjs"], { cwd: tmp, stdio: "pipe" });
    return "OK";
  } catch (e) {
    return String((e as { stderr: Buffer }).stderr);
  }
}

describe("К19 п. 5: реестр развилок и конфликтов", () => {
  it("копии совпадают с SOURCE.md, registry.ts — с генератором", () => {
    const source = readFileSync(`${DIR}/SOURCE.md`, "utf8");
    for (const [file, sha] of [["forks.json", TRIAL_FORKS_SHA256], ["conflicts.json", TRIAL_CONFLICTS_SHA256]] as const) {
      expect(sha256Hex(readFileSync(`${DIR}/${file}`))).toBe(sha);
      expect(source).toContain(sha);
    }
    // побайтная копия комментария чата: хэш закреплён и здесь
    expect(TRIAL_FORKS_SHA256).toBe("778e3abf8fd35233be24d86baecd69b8ced9baa9c8210fbfb0497c103d06d94f");
    execFileSync(process.execPath, ["scripts/gen-trials.mjs", "--check"], { stdio: "pipe" });
  }, 30_000);

  it("развилки Р-1…Р-76, конфликты К1…К20; каждый пункт назначен одному известному репозиторию", () => {
    expect(TRIAL_FORKS.map((f) => f.id)).toEqual(Array.from({ length: 76 }, (_, i) => `Р-${i + 1}`));
    expect(TRIAL_CONFLICTS.map((c) => c.id)).toEqual(Array.from({ length: 20 }, (_, i) => `К${i + 1}`));
    for (const e of [...TRIAL_FORKS, ...TRIAL_CONFLICTS]) expect(TRIAL_REPOS).toContain(e.repo);
  });

  it("назначение КП — по таблице К19 п. 6", () => {
    const by = (repo: string) => TRIAL_CONFLICTS.filter((c) => c.repo === repo).map((c) => Number(c.id.slice(1)));
    expect(by("agentic-core")).toEqual([7, 8]);
    expect(by("agentic-buyer-ref")).toEqual([2, 3, 6, 17]);
    expect(by("agentic-ps-platform")).toEqual([1, 4, 5, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20]);
  });

  it("процессные развилки Р-32…Р-36 и Р-74 — у ядра (решение владельца п. 5)", () => {
    for (const id of ["Р-32", "Р-33", "Р-34", "Р-35", "Р-36", "Р-74"]) expect(TRIAL_FORKS.find((f) => f.id === id)?.repo).toBe("agentic-core");
  });

  it("генератор отказывает: неизвестное поле, тип, повтор, repo, count", () => {
    expect(genOn("forks.json", () => {})).toBe("OK");
    expect(genOn("forks.json", (d) => { d.forks[0].extra = 1; })).toContain("UNKNOWN_FIELD 0.extra");
    expect(genOn("forks.json", (d) => { d.extra = 1; })).toContain("UNKNOWN_FIELD extra");
    expect(genOn("forks.json", (d) => { d.forks[1].rejected = ["a"]; })).toContain("FIELD Р-2.rejected");
    expect(genOn("forks.json", (d) => { d.forks[1].review = 3; })).toContain("FIELD Р-2.review");
    expect(genOn("forks.json", (d) => { delete d.forks[1].chosen; })).toContain("FIELD Р-2.chosen");
    expect(genOn("forks.json", (d) => { d.forks[1].id = "Р-1"; })).toContain("DUPLICATE Р-1");
    expect(genOn("forks.json", (d) => { d.forks[1].id = "R-2"; })).toContain("FIELD R-2.id");
    expect(genOn("forks.json", (d) => { d.forks[1].repo = "agentic-buyer-app"; })).toContain("FIELD Р-2.repo");
    expect(genOn("forks.json", (d) => { d.count = 75; })).toContain("COUNT 75 != 76");
    expect(genOn("conflicts.json", (d) => { d.conflicts[0].stage = "0"; })).toContain("FIELD К1.stage");
  }, 30_000); // 12 запусков node подряд: под нагрузкой машины 5 с vitest по умолчанию не хватает
});
