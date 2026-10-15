// Worker для проверки линейного разбора (П5.2): синхронный цикл не прерывается таймаутом vitest,
// поэтому длинный вход разбирается в отдельном потоке, и тест может его остановить (worker.terminate()).
// Загружает собранный dist: worker_threads не исполняет TypeScript на Node 20.19; сборка — в pretest.
import { parentPort } from "node:worker_threads";

const { PaoClient } = await import(new URL("../dist/src/pao/index.js", import.meta.url).href);
const { newEd25519Signer } = await import(new URL("../dist/src/index.js", import.meta.url).href);
const { signer } = newEd25519Signer("k-x");

const cases = {
  baseUrl: async (n) => {
    new PaoClient({ baseUrl: "http://h" + "/".repeat(n) + "x", agentCode: "a", signer });
    return true;
  },
  retryAfter: async (n) => {
    const out = [];
    for (const header of ["1".repeat(n) + "x", " ".repeat(n) + "1a", "9".repeat(n)]) {
      const fake = async () => new Response("rate limited", { status: 429, headers: { "retry-after": header } });
      const client = new PaoClient({ baseUrl: "http://h", agentCode: "a", signer, fetch: fake, sleep: async () => {} });
      try { await client.call("GET /.well-known/pao-configuration", {}); out.push("ok"); } catch (e) { out.push([e.status, e.attempts]); }
    }
    return out;
  },
};

parentPort.on("message", async ({ kind, n }) => parentPort.postMessage({ result: await cases[kind](n) }));
parentPort.postMessage({ ready: true });
