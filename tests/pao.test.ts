import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { newEd25519Signer, sha256Hex } from "../src/index.js";
import * as core from "../src/index.js";
import {
  PaoClient, PaoCallError, PaoStub, PAO_ERRORS, PAO_SPEC_SHA256, PAO_VERSION, validatePao,
  type ErrorCode, type MandateRequest, type Mandate, type PaoClientOptions, type PaoStubOptions,
} from "../src/pao/index.js";
import { routePattern } from "../src/pao/route.js";

const AGENT = "nspk:agent:buyref-01:v3";
const REQ: MandateRequest = {
  type: "INTENT", subject: "продукты на неделю", amount_limit: 500000, currency: "RUB",
  valid_to: "2026-11-01T00:00:00Z", merchant_scope: ["m-1"], principal_ref: "p-ref-1", mode: "AUTONOMOUS",
};
const created = (r: MandateRequest): Mandate => ({ ...r, id: "MND-1", agent_code: AGENT, status: "PENDING_SIGNATURE" });

let stub: PaoStub | undefined;
afterEach(async () => { await stub?.close(); stub = undefined; });

async function setup(stubOpts: Partial<PaoStubOptions> = {}, clientOpts: Partial<PaoClientOptions> = {}) {
  const { signer, publicKey } = newEd25519Signer("k-2026-10");
  stub = new PaoStub({ agents: [{ agentCode: AGENT, keys: [{ kid: signer.kid, alg: "ed25519", publicKey, status: "ACTIVE" }] }], ...stubOpts });
  const baseUrl = await stub.start();
  const sleeps: number[] = [];
  const client = new PaoClient({ baseUrl, agentCode: AGENT, signer, sleep: async (ms) => { sleeps.push(ms); }, ...clientOpts });
  return { stub, client, sleeps, publicKey, baseUrl };
}

const rejected = (p: Promise<unknown>) => p.then(() => { throw new Error("ожидался отказ"); }, (e: unknown) => e as PaoCallError);

describe("ПАО: спецификация и типы", () => {
  it("копия спецификации совпадает с SOURCE.md и сгенерированными типами", () => {
    const sha = sha256Hex(readFileSync("spec/agent-protocol.yaml"));
    expect(sha).toBe(PAO_SPEC_SHA256);
    expect(readFileSync("spec/SOURCE.md", "utf8")).toContain(sha);
    expect(PAO_VERSION).toBe("1.2.0");
    execFileSync(process.execPath, ["scripts/gen-pao.mjs", "--check"], { stdio: "pipe" });
  });

  it("основной вход не раскрывает протокольный слой (К2, К5)", () => {
    for (const name of Object.keys(core)) expect(name).not.toMatch(/pao|mandate/i);
  });

  it("проверка по схеме находит нарушения", () => {
    expect(validatePao({ $ref: "#/components/schemas/MandateRequest" }, REQ)).toEqual([]);
    expect(validatePao({ $ref: "#/components/schemas/MandateRequest" }, { ...REQ, amount_limit: 0, mode: "X" }))
      .toEqual(["$.amount_limit: меньше 1", '$.mode: "X" вне перечня']);
  });
});

describe("ПАО: клиент против заглушки", () => {
  it("подписанный GET без тела принимается (заготовка С0)", async () => {
    const { client, stub } = await setup();
    const me = await client.call("GET /pao/v1/agent", {});
    expect(me.agent_code).toBe(AGENT);
    expect(stub.calls[0]).toMatchObject({ status: 200 });
    expect(stub.violations).toEqual([]);
  });

  it("изменяющий метод: тело по схеме, Idempotency-Key, повтор с тем же ключом даёт прежний результат", async () => {
    let n = 0;
    const { client, stub } = await setup({ handlers: { "POST /pao/v1/mandates": ({ body }) => (n++, { body: created(body) }) } });
    const m1 = await client.call("POST /pao/v1/mandates", { body: REQ, idempotencyKey: "ik-1" });
    const m2 = await client.call("POST /pao/v1/mandates", { body: REQ, idempotencyKey: "ik-1" });
    expect(m1).toEqual(m2);
    expect(n).toBe(1);
    expect(stub.calls.map((c) => c.replayed)).toEqual([false, true]);
    const e = await rejected(client.call("POST /pao/v1/mandates", { body: { ...REQ, amount_limit: 1 }, idempotencyKey: "ik-1" }));
    expect([e.status, e.code, e.retry]).toEqual([409, "IDEMPOTENCY_CONFLICT", "after_fix"]);
    expect(stub.violations).toEqual([]);
  });

  it("параметры пути и запроса кодируются и входят в подпись", async () => {
    const { client, stub } = await setup({
      handlers: {
        "GET /pao/v1/mandates/{id}": ({ path }) => ({ body: { ...created(REQ), id: path.id! } }),
        "GET /pao/v1/operations": () => ({ body: [] }),
      },
    });
    expect((await client.call("GET /pao/v1/mandates/{id}", { path: { id: "MND/1 ж" } })).id).toBe("MND/1 ж");
    expect(await client.call("GET /pao/v1/operations", { query: { mandate_id: "MND 1&x=2" } })).toEqual([]);
    expect(stub.violations).toEqual([]);
  });

  it("retry=same_key: повтор с тем же Idempotency-Key, новым nonce и подписью", async () => {
    const { client, stub } = await setup({ handlers: { "POST /pao/v1/mandates": ({ body }) => ({ body: created(body) }) } });
    stub.fail("POST /pao/v1/mandates", { code: "IDEMPOTENCY_REQUIRED" });
    await client.call("POST /pao/v1/mandates", { body: REQ });
    expect(stub.calls.map((c) => c.status)).toEqual([400, 201]);
    expect(stub.calls[0]!.idempotencyKey).toBe(stub.calls[1]!.idempotencyKey);
    expect(stub.calls[0]!.nonce).not.toBe(stub.calls[1]!.nonce);
  });

  it("попытки ограничены maxAttempts", async () => {
    const { client, stub, sleeps } = await setup({}, { maxAttempts: 3 });
    stub.fail("POST /pao/v1/mandates", { code: "IDEMPOTENCY_REQUIRED" }, 5);
    const e = await rejected(client.call("POST /pao/v1/mandates", { body: REQ }));
    expect([e.code, e.attempts]).toEqual(["IDEMPOTENCY_REQUIRED", 3]);
    expect(sleeps).toEqual([200, 400]);
  });

  it("retry=new_key: отказ сразу, нужен новый ключ подписи агента", async () => {
    const { signer, publicKey } = newEd25519Signer("k-old");
    stub = new PaoStub({ agents: [{ agentCode: AGENT, keys: [{ kid: "k-old", alg: "ed25519", publicKey, status: "REVOKED" }] }] });
    const client = new PaoClient({ baseUrl: await stub.start(), agentCode: AGENT, signer });
    const e = await rejected(client.call("GET /pao/v1/agent", {}));
    expect([e.status, e.code, e.retry, e.attempts]).toEqual([401, "AGENT_KEY_REVOKED", "new_key", 1]);
  });

  it.each([
    ["MANDATE_SCOPE", 409, "after_human"],
    ["MANDATE_REVOKED", 409, "never"],
    ["CREDENTIALS_FORBIDDEN", 422, "never"],
    ["CREDENTIAL_INVALID", 409, "after_fix"],
  ] as const)("%s → вызывающему без повтора", async (code, status, retry) => {
    const { client, stub } = await setup();
    stub.fail("POST /pao/v1/mandates", { code });
    const e = await rejected(client.call("POST /pao/v1/mandates", { body: REQ }));
    expect([e.status, e.code, e.retry, e.attempts]).toEqual([status, code, retry, 1]);
    expect(stub.calls).toHaveLength(1);
  });

  it("заглушка отвечает по x-pao-errors: HTTP-статус и retry каждого кода, Retry-After у 429 и 503 (РП16)", async () => {
    const { client, stub } = await setup({ retryAfterSec: 7 }, { maxAttempts: 1 });
    const codes = Object.keys(PAO_ERRORS) as ErrorCode[];
    expect(codes).toHaveLength(18);
    for (const code of codes) {
      stub.fail("POST /pao/v1/mandates", { code });
      const e = await rejected(client.call("POST /pao/v1/mandates", { body: REQ }));
      expect([e.code, e.status, e.retry, e.body?.retry]).toEqual([code, PAO_ERRORS[code].http, PAO_ERRORS[code].retry, PAO_ERRORS[code].retry]);
    }
    expect(PAO_ERRORS.RATE_LIMITED).toMatchObject({ http: 429, retry: "same_key" });
    expect(PAO_ERRORS.STATE_UNAVAILABLE).toMatchObject({ http: 503, retry: "same_key" });
    expect(PAO_ERRORS.UPSTREAM_UNAVAILABLE).toMatchObject({ http: 503, retry: "same_key" });
    expect(PAO_ERRORS.AGENT_KEY_REVOKED.retry).toBe("new_key");
  });

  it.each(["RATE_LIMITED", "STATE_UNAVAILABLE", "UPSTREAM_UNAVAILABLE"] as const)(
    "%s (same_key): ожидание по Retry-After, повтор с тем же ключом, новым nonce",
    async (code) => {
      const { client, stub, sleeps } = await setup({ handlers: { "POST /pao/v1/mandates": ({ body }) => ({ body: created(body) }) } });
      stub.fail("POST /pao/v1/mandates", { code, retryAfterSec: 2 });
      await client.call("POST /pao/v1/mandates", { body: REQ });
      expect(sleeps).toEqual([2000]);
      expect(stub.calls.map((c) => c.status)).toEqual([PAO_ERRORS[code].http, 201]);
      expect(stub.calls[0]!.idempotencyKey).toBe(stub.calls[1]!.idempotencyKey);
      expect(stub.calls[0]!.nonce).not.toBe(stub.calls[1]!.nonce);
    },
  );

  it("same_key без Retry-After — пауза по backoff; Retry-After больше потолка — вызывающему сразу", async () => {
    const { signer } = newEd25519Signer("k-x");
    let retryAfter: string | undefined;
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ code: "RATE_LIMITED", message: "", retry: "same_key" }), { status: 429, headers: retryAfter ? { "retry-after": retryAfter } : {} });
    const sleeps: number[] = [];
    const client = new PaoClient({ baseUrl: "http://h", agentCode: AGENT, signer, fetch: fake, sleep: async (ms) => { sleeps.push(ms); }, maxRetryAfterSec: 30 });
    expect((await rejected(client.call("GET /.well-known/pao-configuration", {}))).attempts).toBe(3);
    expect(sleeps).toEqual([200, 400]);
    retryAfter = "31";
    const e = await rejected(client.call("GET /.well-known/pao-configuration", {}));
    expect([e.code, e.retry, e.attempts]).toEqual(["RATE_LIMITED", "same_key", 1]);
  });

  it("retry — по x-pao-errors при совпадении кода и статуса; иначе из тела", async () => {
    const { signer } = newEd25519Signer("k-x");
    let reply = { status: 429, body: { code: "RATE_LIMITED", message: "", retry: "after_fix" } as Record<string, string> };
    const fake: typeof fetch = async () => new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "retry-after": "1" } });
    const client = new PaoClient({ baseUrl: "http://h", agentCode: AGENT, signer, fetch: fake, sleep: async () => {} });
    // Тело расходится с таблицей — верна таблица (РП16): повтор.
    expect([(await rejected(client.call("GET /.well-known/pao-configuration", {}))).retry, (await rejected(client.call("GET /.well-known/pao-configuration", {}))).attempts])
      .toEqual(["same_key", 3]);
    // Код новее этой версии ПАО — как в теле.
    reply = { status: 409, body: { code: "FUTURE_CODE", message: "", retry: "after_human" } };
    const e = await rejected(client.call("GET /.well-known/pao-configuration", {}));
    expect([e.retry, e.attempts]).toEqual(["after_human", 1]);
    // Пара «код, статус» вне таблицы — как в теле.
    reply = { status: 500, body: { code: "UPSTREAM_UNAVAILABLE", message: "", retry: "never" } };
    expect((await rejected(client.call("GET /.well-known/pao-configuration", {}))).attempts).toBe(1);
  });

  it("503 без тела ПАО с Retry-After (прокси) — повтор с тем же ключом", async () => {
    let first = true;
    const proxy: typeof fetch = async (url, init) => {
      if (first) { first = false; return new Response("busy", { status: 503, headers: { "retry-after": "3" } }); }
      return fetch(url, init);
    };
    const { client, stub, sleeps } = await setup({ handlers: { "POST /pao/v1/mandates": ({ body }) => ({ body: created(body) }) } }, { fetch: proxy, idempotencyKey: () => "ik-proxy" });
    await client.call("POST /pao/v1/mandates", { body: REQ });
    expect(sleeps).toEqual([3000]);
    expect(stub.calls.map((c) => [c.status, c.idempotencyKey])).toEqual([[201, "ik-proxy"]]);
  });

  it("baseUrl: хвостовые «/» срезаются за линейное время (CodeQL js/polynomial-redos)", async () => {
    const { signer } = newEd25519Signer("k-x");
    const bad = "http://h" + "/".repeat(200_000) + "x";
    const t0 = performance.now();
    new PaoClient({ baseUrl: bad, agentCode: AGENT, signer });
    expect(performance.now() - t0).toBeLessThan(50);
    const { stub, baseUrl } = await setup();
    const client = new PaoClient({ baseUrl: baseUrl + "///", agentCode: AGENT, signer: newEd25519Signer("k-y").signer });
    await client.call("GET /.well-known/pao-configuration", {});
    expect(stub.violations).toEqual([]);
  });

  it("Retry-After: длинная плохая строка разбирается за миллисекунды, повтора нет", async () => {
    const { signer } = newEd25519Signer("k-x");
    // Без тела ПАО повтор только по разобранному Retry-After; плохой заголовок — вызывающему, огромный — выше потолка.
    for (const header of ["1".repeat(200_000) + "x", " ".repeat(200_000) + "1a", "9".repeat(200_000)]) {
      const fake: typeof fetch = async () => new Response("rate limited", { status: 429, headers: { "retry-after": header } });
      const client = new PaoClient({ baseUrl: "http://h", agentCode: AGENT, signer, fetch: fake, sleep: async () => {} });
      const t0 = performance.now();
      const e = await rejected(client.call("GET /.well-known/pao-configuration", {}));
      expect(performance.now() - t0).toBeLessThan(50);
      expect([e.status, e.attempts]).toEqual([429, 1]);
    }
  });

  it("сбой сети: повтор с тем же Idempotency-Key", async () => {
    let dropped = false;
    const flaky: typeof fetch = async (url, init) => {
      if (!dropped) { dropped = true; throw new TypeError("fetch failed"); }
      return fetch(url, init);
    };
    const { client, stub } = await setup({ handlers: { "POST /pao/v1/mandates": ({ body }) => ({ body: created(body) }) } }, { fetch: flaky, idempotencyKey: () => "ik-net" });
    await client.call("POST /pao/v1/mandates", { body: REQ });
    expect(stub.calls.map((c) => [c.status, c.idempotencyKey])).toEqual([[201, "ik-net"]]);
  });

  it("повтор nonce и выход за окно времени отклоняются (SIGNATURE_INVALID, after_fix)", async () => {
    const { client } = await setup({}, { nonce: () => "n-1" });
    await client.call("GET /pao/v1/agent", {});
    const e = await rejected(client.call("GET /pao/v1/agent", {}));
    expect([e.code, e.retry, e.attempts]).toEqual(["SIGNATURE_INVALID", "after_fix", 1]);
    await stub!.close();
    const late = await setup({}, { now: () => new Date(Date.now() - 3600_000) });
    expect((await rejected(late.client.call("GET /pao/v1/agent", {}))).code).toBe("SIGNATURE_INVALID");
  });

  it("шаблон пути: все спецсимволы в буквальных частях экранируются (CodeQL js/incomplete-sanitization)", () => {
    const re = routePattern("/a+b.c(d)|e*/{id}/f?g[h]$^\\");
    expect(re.exec("/a+b.c(d)|e*/x 1/f?g[h]$^\\")?.groups).toEqual({ id: "x 1" });
    for (const p of ["/aab.c(d)|e*/1/f?g[h]$^\\", "/a+bXc(d)|e*/1/f?g[h]$^\\", "/a+b.cd|e*/1/fg[h]$^\\", "/a+b.c(d)|e*/1/2/f?g[h]$^\\"]) {
      expect(re.test(p)).toBe(false);
    }
    expect(() => routePattern("/x/{a-b}")).toThrow("PAO_PATH_TEMPLATE");
  });

  it("маршруты: буквальные части пути сравниваются точно, параметр — ровно один сегмент", async () => {
    const { stub, baseUrl } = await setup();
    expect((await fetch(baseUrl + "/.well-known/pao-configuration")).status).toBe(200);
    expect((await fetch(baseUrl + "/Xwell-known/pao-configuration")).status).toBe(404);
    expect((await fetch(baseUrl + "/pao/v1/mandates/a/b/verify")).status).toBe(404);
    expect(stub.violations).toEqual([
      "GET /Xwell-known/pao-configuration: нет в спецификации",
      "GET /pao/v1/mandates/a/b/verify: нет в спецификации",
    ]);
  });

  it("исключение в обработчике: в ответе только код ПАО, подробности — в локальный лог", async () => {
    const logged: unknown[] = [];
    const { client, stub } = await setup({
      handlers: { "GET /pao/v1/mandates/{id}": () => { throw new Error("секрет: строка подключения"); } },
      log: (_m, e) => logged.push(e),
    });
    const e = await rejected(client.call("GET /pao/v1/mandates/{id}", { path: { id: "MND-1" } }));
    expect([e.status, e.code, e.retry, e.attempts]).toEqual([500, "UPSTREAM_UNAVAILABLE", "never", 1]);
    expect(e.body).toEqual({ code: "UPSTREAM_UNAVAILABLE", message: "внутренняя ошибка заглушки", retry: "never" });
    expect((logged[0] as Error).message).toBe("секрет: строка подключения");
    expect(stub.violations).toEqual(["GET /pao/v1/mandates/MND-1: исключение в заглушке"]);
  });

  it("заглушка фиксирует ответ обработчика вне схемы", async () => {
    const { client, stub } = await setup({ handlers: { "GET /pao/v1/mandates/{id}/verify": () => ({ body: { outcome: "MAYBE" } as never }) } });
    await client.call("GET /pao/v1/mandates/{id}/verify", { path: { id: "MND-1" } });
    expect(stub.violations).toEqual([
      'GET /pao/v1/mandates/{id}/verify ответ $.amount_left: обязательное поле',
      'GET /pao/v1/mandates/{id}/verify ответ $.valid_to: обязательное поле',
      'GET /pao/v1/mandates/{id}/verify ответ $.outcome: "MAYBE" вне перечня',
    ]);
  });
});
