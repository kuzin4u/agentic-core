// Проверка линейного разбора в worker (П5.2): общий помощник для тестов ПАО и каталога.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

/** Сценарии из `linear-worker.mjs`. */
export type LinearCase = "baseUrl" | "retryAfter" | "a5Price" | "a5Returns" | "xml" | "yml";

/** Разбор длинного входа в worker (П5.2): после загрузки модулей — не больше budgetMs времени процессора, затем terminate().
 *  Синхронный сверхлинейный цикл таймаут vitest не прерывает — без worker он повесил бы CI.
 *  Бюджет — время процессора, а не стенные часы (П2.1, Заделы П1.4): под нагрузкой машины worker получает меньше процессора,
 *  и ложного красного нет. Считается `process.cpuUsage()` процесса vitest (в Node 20.19 нет `threadCpuUsage`):
 *  основной поток в это время ждёт, расход — почти целиком worker; потоки сборщика мусора тоже входят — бюджет с запасом. */
export function linearInWorker(kind: LinearCase, n: number, budgetMs = 2000): Promise<unknown> {
  // каждый src/**/*.ts — не новее своего dist/src/**/*.js (без pretest dist мог устареть)
  for (const f of readdirSync("src", { recursive: true }) as string[]) {
    if (!f.endsWith(".ts")) continue;
    const src = join("src", f), out = join("dist", "src", f.replace(/\.ts$/, ".js"));
    if ((statSync(out, { throwIfNoEntry: false })?.mtimeMs ?? 0) < statSync(src).mtimeMs) throw new Error(`${out} старше ${src}: npm run build (в npm test — pretest)`);
  }
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./linear-worker.mjs", import.meta.url));
    let timer: ReturnType<typeof setInterval> | undefined;
    let start: NodeJS.CpuUsage | undefined;
    const cpuMs = () => { const d = process.cpuUsage(start); return (d.user + d.system) / 1000; };
    const done = (f: () => void) => { clearInterval(timer); void w.terminate(); f(); };
    const over = () => done(() => reject(new Error(`сверхлинейный разбор: ${kind} на ${n} символов — больше ${budgetMs} мс процессора`)));
    w.on("message", (m: { ready?: true; result?: unknown }) => {
      if (m.ready) {
        start = process.cpuUsage();
        timer = setInterval(() => { if (cpuMs() > budgetMs) over(); }, 50);
        w.postMessage({ kind, n });
      } else if (cpuMs() > budgetMs) over();
      else done(() => resolve(m.result));
    });
    w.on("error", (e) => done(() => reject(e)));
  });
}
