import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { newEd25519Signer, sha256Hex, signRequest, type Signer } from "../src/index.js";
import * as core from "../src/index.js";
import {
  PaoClient, PaoCallError, PaoStub, PAO_ERRORS, PAO_SPEC_SHA256, PAO_VERSION, validatePao,
  type ErrorCode, type MandateRequest, type Mandate, type PaoClientOptions, type PaoStubOptions,
} from "../src/pao/index.js";
import { routePattern } from "../src/pao/route.js";
import { linearInWorker } from "./linear.js";

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
    expect(PAO_VERSION).toBe("1.4.0");
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

  it("ПАО 1.4.0 (К16): agent_code в Mandate обязателен, revocation_order и records необязательны", () => {
    const m = created(REQ);
    const { agent_code: _, ...noCode } = m;
    expect(validatePao({ $ref: "#/components/schemas/Mandate" }, m)).toEqual([]);
    expect(validatePao({ $ref: "#/components/schemas/Mandate" }, { ...m, revocation_order: "bank:B1:revocation:v1" })).toEqual([]);
    expect(validatePao({ $ref: "#/components/schemas/Mandate" }, noCode)).toEqual(["$.agent_code: обязательное поле"]);
    const record = { seq: 1, kind: "MANDATE_CREATED", ref: "MND-1", parent_ref: null, at: "2026-10-18T00:00:00Z", payload: {}, prev_hash: "0", hash: "1" };
    expect(validatePao({ $ref: "#/components/schemas/Evidence" }, { mandate_chain: [m], records: [record], integrity: "OK" })).toEqual([]);
    expect(validatePao({ $ref: "#/components/schemas/Evidence" }, { records: [{ ...record, parent_ref: undefined }] }))
      .toEqual(["$.records[0].parent_ref: обязательное поле"]);
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

  it.each([
    ["POST /pao/v1/mandates", "REQUEST_INVALID", 400],
    ["POST /pao/v1/agent/keys", "REQUEST_INVALID", 400],
    ["POST /pao/v1/agent/keys", "KEY_INVALID", 422],
  ] as const)("ПАО 1.3.0 (РП31): %s, %s → %i after_fix, без повтора", async (op, code, status) => {
    expect(PAO_ERRORS[code]).toMatchObject({ http: status, retry: "after_fix" });
    const { client, stub } = await setup();
    stub.fail(op, { code });
    const e = await rejected(client.call(op, { body: {} as never }));
    expect([e.status, e.code, e.retry, e.attempts, e.body?.retry]).toEqual([status, code, "after_fix", 1, "after_fix"]);
    expect(stub.calls).toHaveLength(1);
  });

  it("заглушка отвечает по x-pao-errors: HTTP-статус и retry каждого кода, Retry-After у 429 и 503 (РП16)", async () => {
    const { client, stub } = await setup({ retryAfterSec: 7 }, { maxAttempts: 1 });
    const codes = Object.keys(PAO_ERRORS) as ErrorCode[];
    expect(codes).toHaveLength(20);
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
    expect(await linearInWorker("baseUrl", 2_000_000)).toBe(true);
    const { stub, baseUrl } = await setup();
    const client = new PaoClient({ baseUrl: baseUrl + "///", agentCode: AGENT, signer: newEd25519Signer("k-y").signer });
    await client.call("GET /.well-known/pao-configuration", {});
    expect(stub.violations).toEqual([]);
  });

  it("запрос без подписи не отправляет заголовки агента; подписанный — отправляет (CO-1 агента, #31)", async () => {
    const { signer } = newEd25519Signer("k-x");
    const sent: Record<string, string>[] = [];
    const fake: typeof fetch = async (_url, init) => {
      sent.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])));
      return new Response("{}", { status: 200 });
    };
    const client = new PaoClient({ baseUrl: "http://h", agentCode: AGENT, signer, fetch: fake });
    await client.call("GET /.well-known/pao-configuration", {});
    await client.call("GET /pao/v1/agent", {});
    const agentHeaders = (h: Record<string, string>) => Object.keys(h).filter((k) => ["x-agent-code", "x-timestamp", "x-nonce", "signature", "signature-input", "content-digest"].includes(k)).sort();
    expect(agentHeaders(sent[0]!)).toEqual([]);
    expect(agentHeaders(sent[1]!)).toEqual(["content-digest", "signature", "signature-input", "x-agent-code", "x-nonce", "x-timestamp"]);
    expect(Object.values(sent[0]!)).not.toContain(AGENT);
  });

  it("Retry-After: длинная плохая строка разбирается линейно, повтора нет", async () => {
    // Без тела ПАО повтор только по разобранному Retry-After; плохой заголовок — вызывающему, огромный — выше потолка.
    expect(await linearInWorker("retryAfter", 2_000_000)).toEqual([[429, 1], [429, 1], [429, 1]]);
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

describe("ПАО: заглушка по РП23 (порядок проверки, статус, ключи, журнал обращений)", () => {
  /** Подписанное обращение в обход клиента: headers можно испортить до отправки. */
  function signed(signer: Signer, method: string, path: string, nonce: string, body = "") {
    const headers = { "x-agent-code": AGENT, "x-timestamp": new Date().toISOString().slice(0, 19) + "Z", "x-nonce": nonce };
    return signRequest({ method, path, query: "", headers, body }, signer).headers;
  }
  const send = (baseUrl: string, method: string, path: string, headers: Record<string, string>, body?: string) =>
    fetch(baseUrl + path, { method, headers: { ...headers, "content-type": "application/json" }, body });

  it.each(["SUSPENDED", "EXCLUDED"] as const)("%s: GET /pao/v1/agent — 200 со статусом, остальное — 403 AGENT_SUSPENDED", async (status) => {
    const { client, stub } = await setup({ handlers: { "POST /pao/v1/mandates": ({ body }) => ({ body: created(body) }) } });
    stub["opts"].agents[0]!.status = status;
    expect((await client.call("GET /pao/v1/agent", {})).status).toBe(status);
    const e = await rejected(client.call("POST /pao/v1/mandates", { body: REQ, idempotencyKey: "ik-s" }));
    expect([e.status, e.code, e.attempts]).toEqual([403, "AGENT_SUSPENDED", 1]);
    expect(stub.calls.map((c) => [c.method, c.path, c.status, c.code])).toEqual([
      ["GET", "/pao/v1/agent", 200, undefined],
      ["POST", "/pao/v1/mandates", 403, "AGENT_SUSPENDED"],
    ]);
    expect(stub.violations).toEqual([]);
  });

  it("сначала подпись, потом статус: неподписанное и испорченное обращение приостановленного — 401, не 403", async () => {
    const { stub, baseUrl } = await setup();
    stub["opts"].agents[0]!.status = "SUSPENDED";
    const unsigned = await send(baseUrl, "POST", "/pao/v1/mandates", { "x-agent-code": AGENT, "idempotency-key": "ik-u" }, JSON.stringify(REQ));
    expect([unsigned.status, (await unsigned.json()).code]).toEqual([401, "SIGNATURE_INVALID"]);
    const unknown = await send(baseUrl, "GET", "/pao/v1/agent", { "x-agent-code": "nspk:agent:nobody:v1" });
    expect([unknown.status, (await unknown.json()).code]).toEqual([401, "AGENT_UNKNOWN"]);
    expect(stub.calls.map((c) => [c.status, c.code])).toEqual([[401, "SIGNATURE_INVALID"], [401, "AGENT_UNKNOWN"]]);
  });

  it("nonce запоминается только после успешной проверки: испорченная подпись не занимает nonce, повтор удачного — 401", async () => {
    const { signer, publicKey } = newEd25519Signer("k-n");
    stub = new PaoStub({ agents: [{ agentCode: AGENT, keys: [{ kid: "k-n", alg: "ed25519", publicKey }] }] });
    const baseUrl = await stub.start();
    const h = signed(signer, "GET", "/pao/v1/agent", "nonce-1");
    const bad = await send(baseUrl, "GET", "/pao/v1/agent", { ...h, signature: "sig1=:" + Buffer.alloc(64).toString("base64") + ":" });
    expect(bad.status).toBe(401);
    expect((await send(baseUrl, "GET", "/pao/v1/agent", h)).status).toBe(200);
    expect((await send(baseUrl, "GET", "/pao/v1/agent", h)).status).toBe(401);
    expect(stub.calls.map((c) => [c.status, c.kid, c.nonce])).toEqual([[401, "k-n", "nonce-1"], [200, "k-n", "nonce-1"], [401, "k-n", "nonce-1"]]);
  });

  it("GET /pao/v1/agent: operator, class, level, rate_limit_per_min; только действующие ключи со сроками", async () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const { signer, publicKey } = newEd25519Signer("k-live");
    const old = newEd25519Signer("k-old"), gone = newEd25519Signer("k-gone");
    stub = new PaoStub({
      now: () => now,
      agents: [{
        agentCode: AGENT, operator: "nspk:operator:op-1", class: "BUYER", level: 2, rateLimitPerMin: 60,
        keys: [
          { kid: "k-live", alg: "ed25519", publicKey, validFrom: "2026-10-01T00:00:00Z", validTo: "2026-12-30T00:00:00Z" },
          { kid: "k-old", alg: "ed25519", publicKey: old.publicKey, validTo: "2026-10-16T12:00:00Z" },
          { kid: "k-gone", alg: "ed25519", publicKey: gone.publicKey, status: "REVOKED" },
        ],
      }],
    });
    const baseUrl = await stub.start();
    const clientAt = (s: Signer) => new PaoClient({ baseUrl, agentCode: AGENT, signer: s, now: () => new Date(now) });
    expect(await clientAt(signer).call("GET /pao/v1/agent", {})).toEqual({
      agent_code: AGENT, operator: "nspk:operator:op-1", class: "BUYER", level: 2, status: "ACTIVE", rate_limit_per_min: 60,
      keys: [{ kid: "k-live", alg: "ed25519", public_key: publicKey, status: "ACTIVE", valid_from: "2026-10-01T00:00:00Z", valid_to: "2026-12-30T00:00:00Z" }],
    });
    // valid_to наступил — EXPIRED на момент проверки; в ПАО отдельного кода нет — AGENT_KEY_REVOKED (РП23 п. 6.2)
    const e = await rejected(clientAt(old.signer).call("GET /pao/v1/agent", {}));
    expect([e.status, e.code]).toEqual([401, "AGENT_KEY_REVOKED"]);
    expect(stub.violations).toEqual([]);
  });
});

describe("ПАО: заглушка — регистрация ключа POST /pao/v1/agent/keys (РП23 п. 2–4, доп. 1, 6, 7; РП31 п. 2)", () => {
  const SPKI = "302a300506032b6570032100";
  const spki = (x: Buffer) => Buffer.concat([Buffer.from(SPKI, "hex"), x]).toString("base64");
  // RFC 8037 прил. A.2–A.3: открытый ключ и его отпечаток RFC 7638
  const RFC_X = Buffer.from("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", "base64url");
  const RFC_KID = "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k";
  const NOW = Date.parse("2026-10-16T12:00:00Z");
  const DAY = 24 * 3600 * 1000;
  const OTHER = "nspk:agent:other-01:v1";

  async function setupKeys(extra: PaoStubOptions["agents"][number]["keys"] = [], other: PaoStubOptions["agents"][number]["keys"] = []) {
    const { signer, publicKey } = newEd25519Signer("k-1");
    stub = new PaoStub({
      now: () => NOW,
      agents: [
        { agentCode: AGENT, keys: [{ kid: "k-1", alg: "ed25519", publicKey, validTo: new Date(NOW + 60 * DAY).toISOString() }, ...extra] },
        { agentCode: OTHER, keys: other },
      ],
    });
    const baseUrl = await stub.start();
    const clientWith = (s: Signer) => new PaoClient({ baseUrl, agentCode: AGENT, signer: s, now: () => new Date(NOW) });
    return { stub, client: clientWith(signer), clientWith, me: stub["opts"].agents[0]! };
  }

  it("kid — отпечаток RFC 7638 (эталон RFC 8037 прил. A.3); сроки нового ключа и сокращение прежнего; новый ключ подписывает", async () => {
    const { client, clientWith, stub } = await setupKeys();
    const key = await client.call("POST /pao/v1/agent/keys", { body: { alg: "ed25519", public_key: spki(RFC_X) }, idempotencyKey: "ik-k1" });
    expect(key).toEqual({
      kid: RFC_KID, alg: "ed25519", public_key: spki(RFC_X), status: "ACTIVE",
      valid_from: new Date(NOW).toISOString(), valid_to: new Date(NOW + 90 * DAY).toISOString(),
    });
    expect(stub.calls.at(-1)).toMatchObject({ method: "POST", path: "/pao/v1/agent/keys", status: 201, kid: "k-1" });
    const fresh = newEd25519Signer("tmp");
    const k2 = await client.call("POST /pao/v1/agent/keys", { body: { alg: "ed25519", public_key: fresh.publicKey }, idempotencyKey: "ik-k2" });
    const me = await clientWith({ ...fresh.signer, kid: k2.kid }).call("GET /pao/v1/agent", {});
    // прежние действующие — до now + key_overlap_days; уже более короткий срок не продлевается
    const overlap = new Date(NOW + 7 * DAY).toISOString();
    expect(me.keys!.map((k) => [k.kid, k.valid_to])).toEqual([["k-1", overlap], [RFC_KID, overlap], [k2.kid, new Date(NOW + 90 * DAY).toISOString()]]);
    expect(stub.violations).toEqual([]);
  });

  it("свой действующий ключ повторно (другой Idempotency-Key) — 201 тот же Key, ключей и сроков не прибавилось (РП23 доп. 7)", async () => {
    const { client, me } = await setupKeys();
    const body = { alg: "ed25519", public_key: spki(RFC_X) };
    const first = await client.call("POST /pao/v1/agent/keys", { body, idempotencyKey: "ik-a" });
    const before = structuredClone(me.keys);
    const again = await client.call("POST /pao/v1/agent/keys", { body, idempotencyKey: "ik-b" });
    expect(again).toEqual(first);
    expect(me.keys).toEqual(before);
    expect(stub!.calls.map((c) => [c.status, c.replayed])).toEqual([[201, false], [201, false]]);
  });

  const weak = Buffer.alloc(32); weak[0] = 1; // нейтраль (0, 1): малого порядка
  const rfc = spki(RFC_X);
  it.each<[string, Record<string, unknown>]>([
    ["alg не из перечня контура", { alg: "gost-2012", public_key: rfc }],
    ["неканоническая запись base64 (лишние биты перед «=»)", { alg: "ed25519", public_key: rfc.slice(0, -2) + "p=" }],
    ["без дополнения", { alg: "ed25519", public_key: rfc.replace(/=+$/, "") }],
    ["перевод строки", { alg: "ed25519", public_key: rfc.slice(0, 20) + "\n" + rfc.slice(20) }],
    ["алфавит base64url", { alg: "ed25519", public_key: Buffer.from(rfc, "base64").toString("base64url") }],
    ["не DER SPKI Ed25519", { alg: "ed25519", public_key: Buffer.alloc(44, 7).toString("base64") }],
    ["слабый ключ (точка малого порядка)", { alg: "ed25519", public_key: spki(weak) }],
  ])("KEY_INVALID 422 после одного обращения: %s", async (_name, body) => {
    const { client, me } = await setupKeys();
    const e = await rejected(client.call("POST /pao/v1/agent/keys", { body: body as never, idempotencyKey: "ik-x" }));
    expect([e.status, e.code, e.retry, e.attempts]).toEqual([422, "KEY_INVALID", "after_fix", 1]);
    expect(me.keys).toHaveLength(1);
  });

  it.each([
    ["ключ другого агента", [], [{ kid: RFC_KID, alg: "ed25519", publicKey: rfc }]],
    ["свой отозванный", [{ kid: RFC_KID, alg: "ed25519", publicKey: rfc, status: "REVOKED" as const }], []],
    ["свой истёкший", [{ kid: RFC_KID, alg: "ed25519", publicKey: rfc, validTo: new Date(NOW - 1).toISOString() }], []],
  ])("KEY_INVALID: %s — уже зарегистрирован (РП23 п. 3, доп. 7)", async (_name, own, other) => {
    const { client, me } = await setupKeys(own, other);
    const e = await rejected(client.call("POST /pao/v1/agent/keys", { body: { alg: "ed25519", public_key: rfc }, idempotencyKey: "ik-t" }));
    expect([e.status, e.code]).toEqual([422, "KEY_INVALID"]);
    expect(me.keys).toHaveLength(1 + own.length);
  });

  it("нет public_key — REQUEST_INVALID 400; приостановленному — 403 AGENT_SUSPENDED, ключ не добавлен", async () => {
    const { client, me } = await setupKeys();
    const e = await rejected(client.call("POST /pao/v1/agent/keys", { body: { alg: "ed25519" } as never, idempotencyKey: "ik-r" }));
    expect([e.status, e.code]).toEqual([400, "REQUEST_INVALID"]);
    me.status = "SUSPENDED";
    const s = await rejected(client.call("POST /pao/v1/agent/keys", { body: { alg: "ed25519", public_key: rfc }, idempotencyKey: "ik-s" }));
    expect([s.status, s.code]).toEqual([403, "AGENT_SUSPENDED"]);
    expect(me.keys).toHaveLength(1);
  });
});
