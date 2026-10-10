import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { IdempotencyConflict, IdempotencyStore } from "../idempotency.js";
import { verifyRequest } from "../signing.js";
import { PAO_ERRORS, PAO_OPERATIONS, type Configuration, type ErrorCode, type Error as PaoErrorBody, type PaoOperationKey, type PaoOperations } from "./types.js";
import { validatePao } from "./validate.js";
import { routePattern } from "./route.js";

export interface PaoStubAgent {
  agentCode: string;
  status?: "ACTIVE" | "SUSPENDED";
  keys: { kid: string; alg: string; publicKey: string; status: "ACTIVE" | "REVOKED" | "EXPIRED" }[];
}

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

export interface PaoStubCall { op: PaoOperationKey | undefined; status: number; nonce?: string; idempotencyKey?: string; replayed: boolean }

/** Сервер-заглушка ПАО для контрактных тестов: проверяет подпись, окно времени, nonce, Idempotency-Key
 *  и тела по схемам спецификации; ответы — от обработчиков теста. Нарушения схем копятся в `violations`. */
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
    const call: PaoStubCall = { op: undefined, status: 0, nonce, idempotencyKey, replayed: false };
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
      const after = e.retryAfterSec ?? (status === 429 || status === 503 ? (this.opts.retryAfterSec ?? 1) : undefined);
      return reply(status, body, after !== undefined ? { "retry-after": String(after) } : undefined);
    };

    let agentCode = "";
    if (spec.signed) {
      agentCode = headers["x-agent-code"] ?? "";
      const agent = this.opts.agents.find((a) => a.agentCode === agentCode);
      if (!agent) return fail({ code: "AGENT_UNKNOWN" });
      if (agent.status === "SUSPENDED") return fail({ code: "AGENT_SUSPENDED" });
      const v = verifyRequest(
        { method, path: url.pathname, query: url.search.replace(/^\?/, ""), headers, body: text },
        (kid) => agent.keys.find((k) => k.kid === kid),
        {
          now: (this.opts.now ?? Date.now)(),
          skewSec: this.opts.skewSec ?? 300,
          seenNonce: (n) => !n || this.nonces.has(`${agentCode} ${n}`) || (this.nonces.add(`${agentCode} ${n}`), false),
        },
      );
      if (!v.ok) return fail({ code: v.code });
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
      return {
        body: {
          agent_code: a.agentCode,
          status: a.status ?? "ACTIVE",
          keys: a.keys.map((k) => ({ kid: k.kid, alg: k.alg, public_key: k.publicKey, status: k.status })),
        },
      };
    }
    this.violations.push(`${op}: нет обработчика в заглушке`);
    return { error: { code: "UPSTREAM_UNAVAILABLE", message: "нет обработчика в заглушке", status: 500, retry: "never" } };
  }

  private send(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", ...extra });
    res.end(text);
  }
}
