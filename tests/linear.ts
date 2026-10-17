// Проверка линейного разбора в worker (П5.2): общий помощник для тестов ПАО и каталога.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

/** Сценарии из `linear-worker.mjs`. */
export type LinearCase = "baseUrl" | "retryAfter" | "a5Price" | "a5Returns" | "xml";

/** Разбор длинного входа в worker (П5.2): ждать не дольше budgetMs после загрузки модулей, затем terminate().
 *  Синхронный сверхлинейный цикл таймаут vitest не прерывает — без worker он повесил бы CI. */
export function linearInWorker(kind: LinearCase, n: number, budgetMs = 2000): Promise<unknown> {
  // каждый src/**/*.ts — не новее своего dist/src/**/*.js (без pretest dist мог устареть)
  for (const f of readdirSync("src", { recursive: true }) as string[]) {
    if (!f.endsWith(".ts")) continue;
    const src = join("src", f), out = join("dist", "src", f.replace(/\.ts$/, ".js"));
    if ((statSync(out, { throwIfNoEntry: false })?.mtimeMs ?? 0) < statSync(src).mtimeMs) throw new Error(`${out} старше ${src}: npm run build (в npm test — pretest)`);
  }
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./linear-worker.mjs", import.meta.url));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (f: () => void) => { clearTimeout(timer); void w.terminate(); f(); };
    w.on("message", (m: { ready?: true; result?: unknown }) => {
      if (m.ready) {
        timer = setTimeout(() => done(() => reject(new Error(`сверхлинейный разбор: ${kind} на ${n} символов дольше ${budgetMs} мс`))), budgetMs);
        w.postMessage({ kind, n });
      } else done(() => resolve(m.result));
    });
    w.on("error", (e) => done(() => reject(e)));
  });
}
