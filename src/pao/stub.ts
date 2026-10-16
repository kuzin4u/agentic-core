import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { IdempotencyConflict, IdempotencyStore } from "../idempotency.js";
import { verifyRequest } from "../signing.js";
import { PAO_ERRORS, PAO_OPERATIONS, type Configuration, type ErrorCode, type Key, type Error as PaoErrorBody, type PaoOperationKey, type PaoOperations } from "./types.js";
import { validatePao } from "./validate.js";
import { routePattern } from "./route.js";

/** Ключ агента в заглушке. `status` по умолчанию ACTIVE; ключ с наступившим `validTo` — EXPIRED на момент проверки (РП23 п. 4). */
export interface PaoStubKey {
  kid: string;
  alg: string;
  publicKey: string;
  status?: "ACTIVE" | "REVOKED" | "EXPIRED";
  /** ISO 8601 */
  validFrom?: string;
  /** ISO 8601 */
  validTo?: string;
}

/** Агент в заглушке; поля `operator`, `class`, `level`, `rateLimitPerMin` уходят в `GET /pao/v1/agent` как есть.
 *  Статус и ключи читаются на каждом обращении: тест может менять их между вызовами. */
export interface PaoStubAgent {
  agentCode: string;
  status?: "ACTIVE" | "SUSPENDED" | "EXCLUDED";
  operator?: string;
  class?: "BUYER" | "SELLER" | "SURFACE" | "SERVICE";
  level?: number;
  rateLimitPerMin?: number;
  keys: PaoStubKey[];
}

/** Методы, доступные агенту в статусе SUSPENDED и EXCLUDED: по ним он узнаёт свой статус (РП23 п. 6.3). */
const STATUS_EXEMPT: ReadonlySet<PaoOperationKey> = new Set(["GET /pao/v1/agent"]);

/** Отказ, который заглушка вернёт вместо ответа. Статус и `retry` по умолчанию — из x-pao-errors спецификации (`PAO_ERRORS`).
 *  `retryAfterSec` — заголовок Retry-After; у 429 и 503 по умолчанию `PaoStubOptions.retryAfterSec` (РП16). */
export interface PaoStubError { code: ErrorCode; message?: string; status?: number; retry?: PaoErrorBody["retry"]; retryAfterSec?: number }

export type PaoStubReply<K extends PaoOperationKey> = { status?: number; body: PaoOperations[K]["response"] } | { error: PaoStubError };

export type PaoStubHandler<K extends PaoOperationKey> = (req: {
  agentCode: string;
  path: Record<string, string>;
  query: Record<string, string>;
  body: PaoOperations[K]["body"];
}) => PaoStubReply<K>;

export interface PaoStubOptions {
  agents: PaoStubAgent[];
  handlers?: { [K in PaoOperationKey]?: PaoStubHandler<K> };
  configuration?: Configuration;
  skewSec?: number;
  /** Retry-After у отказов 429 и 503, если в отказе не задан свой; секунд. По умолчанию 1. */
  retryAfterSec?: number;
  now?: () => number;
  /** Локальный лог исключений обработчиков; по умолчанию console.error. В ответ клиенту подробности не попадают. */
  log?: (message: string, error: unknown) => void;
}

/** Журнал обращений: `code` — код отказа ПАО (у успешного ответа нет), `kid` — keyid из Signature-Input, если он есть. */
export interface PaoStubCall {
  op: PaoOperationKey | undefined;
  method: string;
  path: string;
  status: number;
  code?: ErrorCode;
  kid?: string;
  nonce?: string;
  idempotencyKey?: string;
  replayed: boolean;
}

/** Сервер-заглушка ПАО для контрактных тестов: проверяет подпись, окно времени, nonce, Idempotency-Key
 *  и тела по схемам спецификации; ответы — от обработчиков теста. Нарушения схем копятся в `violations`.
 *  Порядок проверки — РП23 п. 6: агент → подпись → статус агента. */
export class PaoStub {
  readonly calls: PaoStubCall[] = [];
  readonly violations: string[] = [];
  private server?: Server;
  private nonces = new Set<string>();
  private idem: IdempotencyStore<{ status: number; body: unknown }>;
  private failures = new Map<PaoOperationKey, PaoStubError[]>();
  private routes = Object.entries(PAO_OPERATIONS).map(([op, s]) => ({
    op: op as PaoOperationKey,
    spec: s,
    re: routePattern(s.path),
  }));

  constructor(private readonly opts: PaoStubOptions) {
    this.idem = new IdempotencyStore(24 * 3600 * 1000, opts.now);
  }

  /** Следующие `times` вызовов операции получат этот отказ (после проверки подписи). */
  fail(op: PaoOperationKey, error: PaoStubError, times = 1): this {
    const q = this.failures.get(op) ?? [];
    for (let i = 0; i < times; i++) q.push(error);
    this.failures.set(op, q);
    return this;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => {
        // Подробности — только в локальный лог; в ответе код ПАО и краткое сообщение.
        (this.opts.log ?? console.error)("PaoStub: исключение в обработке запроса", e);
        this.violations.push(`${req.method} ${req.url}: исключение в заглушке`);
        if (res.headersSent) return void res.end();
        const body: PaoErrorBody = { code: "UPSTREAM_UNAVAILABLE", message: "внутренняя ошибка заглушки", retry: "never" };
        this.send(res, 500, body);
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    if (this.server) await new Promise<void>((r, j) => this.server!.close((e) => (e ? j(e) : r())));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://stub");
    const method = (req.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]));
    const nonce = headers["x-nonce"];
    const idempotencyKey = headers["idempotency-key"] || undefined;
    const kid = /;keyid="([^"]+)"/.exec(headers["signature-input"] ?? "")?.[1];
    const call: PaoStubCall = { op: undefined, method, path: url.pathname, status: 0, kid, nonce, idempotencyKey, replayed: false };
    this.calls.push(call);

    const route = this.routes.find((r) => r.spec.method === method && r.re.test(url.pathname));
    if (!route) {
      this.violations.push(`${method} ${url.pathname}: нет в спецификации`);
      return this.send(res, (call.status = 404), undefined);
    }
    const { op, spec } = route;
    call.op = op;
    const pathParams = Object.fromEntries(
      Object.entries(route.re.exec(url.pathname)!.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]),
    );
    const query = Object.fromEntries(url.searchParams);
    const reply = (status: number, body: unknown, extra?: Record<string, string>) => this.send(res, (call.status = status), body, extra);
    const fail = (e: PaoStubError) => {
      const { http, retry } = PAO_ERRORS[e.code];
      const status = e.status ?? http;
      const body: PaoErrorBody = { code: e.code, message: e.message ?? e.code, retry: e.retry ?? retry };
      call.code = e.code;
      const after = e.retryAfterSec ?? (status === 429 || status === 503 ? (this.opts.retryAfterSec ?? 1) : undefined);
      return reply(status, body, after !== undefined ? { "retry-after": String(after) } : undefined);
    };

    let agentCode = "";
    if (spec.signed) {
      agentCode = headers["x-agent-code"] ?? "";
      const agent = this.opts.agents.find((a) => a.agentCode === agentCode);
      if (!agent) return fail({ code: "AGENT_UNKNOWN" });
      const now = this.now();
      const v = verifyRequest(
        { method, path: url.pathname, query: url.search.replace(/^\?/, ""), headers, body: text },
        (k) => {
          const key = agent.keys.find((x) => x.kid === k);
          return key && { alg: key.alg, publicKey: key.publicKey, status: keyStatus(key, now) };
        },
        {
          now,
          skewSec: this.opts.skewSec ?? 300,
          // Только проверка: nonce запоминается после успешной проверки подписи (РП23 п. 6.2).
          seenNonce: (n) => !n || this.nonces.has(`${agentCode} ${n}`),
        },
      );
      if (!v.ok) return fail({ code: v.code });
      this.nonces.add(`${agentCode} ${nonce}`);
      if ((agent.status ?? "ACTIVE") !== "ACTIVE" && !STATUS_EXEMPT.has(op)) return fail({ code: "AGENT_SUSPENDED" });
    }

    const scripted = this.failures.get(op)?.shift();
    if (scripted) return fail(scripted);

    let body: unknown;
    if (spec.body !== undefined) {
      try { body = JSON.parse(text); } catch { this.violations.push(`${op}: тело не JSON`); }
      if (body !== undefined) this.violations.push(...validatePao(spec.body, body, "$").map((m) => `${op} запрос ${m}`));
    }
    for (const q of spec.query) if (q.required && query[q.name] === undefined) this.violations.push(`${op}: нет параметра ${q.name}`);

    const run = (): { status: number; body: unknown } | { error: PaoStubError } => {
      const handler = this.opts.handlers?.[op] as PaoStubHandler<PaoOperationKey> | undefined;
      const r = handler ? handler({ agentCode, path: pathParams, query, body: body as never }) : this.defaultReply(op, agentCode);
      if ("error" in r) return r;
      if (spec.response !== undefined) this.violations.push(...validatePao(spec.response, r.body, "$").map((m) => `${op} ответ ${m}`));
      return { status: r.status ?? spec.success, body: r.body };
    };

    if (!spec.idempotent) {
      const r = run();
      return "error" in r ? fail(r.error) : reply(r.status, r.body);
    }
    if (!idempotencyKey) return fail({ code: "IDEMPOTENCY_REQUIRED" });
    let failed: PaoStubError | undefined;
    try {
      const { result, replayed } = this.idem.run(`${agentCode} ${idempotencyKey}`, { op, path: pathParams, body: body ?? null }, () => {
        const r = run();
        if ("error" in r) throw (failed = r.error);
        return r;
      });
      call.replayed = replayed;
      return reply(result.status, result.body);
    } catch (e) {
      if (e instanceof IdempotencyConflict) return fail({ code: "IDEMPOTENCY_CONFLICT" });
      if (failed) return fail(failed);
      throw e;
    }
  }

  private defaultReply(op: PaoOperationKey, agentCode: string): PaoStubReply<PaoOperationKey> {
    if (op === "GET /.well-known/pao-configuration") {
      return { body: this.opts.configuration ?? { versions: ["v1"], algorithms: ["ed25519"], platform_keys: [], endpoints: {} } };
    }
    if (op === "GET /pao/v1/agent") {
      const a = this.opts.agents.find((x) => x.agentCode === agentCode)!;
      const now = this.now();
      // Как у Платформы: в ответе только действующие ключи; срок — на момент обращения.
      const keys = a.keys.filter((k) => keyStatus(k, now) === "ACTIVE").map(keyBody);
      return {
        body: {
          agent_code: a.agentCode,
          ...(a.operator !== undefined && { operator: a.operator }),
          ...(a.class !== undefined && { class: a.class }),
          ...(a.level !== undefined && { level: a.level }),
          status: a.status ?? "ACTIVE",
          keys,
          ...(a.rateLimitPerMin !== undefined && { rate_limit_per_min: a.rateLimitPerMin }),
        },
      };
    }
    this.violations.push(`${op}: нет обработчика в заглушке`);
    return { error: { code: "UPSTREAM_UNAVAILABLE", message: "нет обработчика в заглушке", status: 500, retry: "never" } };
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private send(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", ...extra });
    res.end(text);
  }
}

function keyStatus(k: PaoStubKey, now: number): "ACTIVE" | "REVOKED" | "EXPIRED" {
  const s = k.status ?? "ACTIVE";
  if (s !== "ACTIVE") return s;
  return k.validTo !== undefined && Date.parse(k.validTo) <= now ? "EXPIRED" : "ACTIVE";
}

function keyBody(k: PaoStubKey): Key {
  return {
    kid: k.kid, alg: k.alg, public_key: k.publicKey, status: "ACTIVE",
    ...(k.validFrom !== undefined && { valid_from: k.validFrom }),
    ...(k.validTo !== undefined && { valid_to: k.validTo }),
  };
}
