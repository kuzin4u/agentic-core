import { randomUUID } from "node:crypto";
import { canonicalJson } from "../canonical.js";
import { signRequest, type Signer } from "../signing.js";
import { PAO_OPERATIONS, type PaoOperations, type PaoOperationKey, type Error as PaoErrorBody, type ErrorCode } from "./types.js";

export type RetryAdvice = PaoErrorBody["retry"];

type Field<T, F extends string> = [T] extends [never] ? { [P in F]?: never } : {} extends T ? { [P in F]?: T } : { [P in F]: T };

/** Аргументы вызова операции: параметры пути, запроса и тело — по спецификации. */
export type PaoCallArgs<K extends PaoOperationKey> =
  Field<PaoOperations[K]["path"], "path"> & Field<PaoOperations[K]["query"], "query"> & Field<PaoOperations[K]["body"], "body"> &
  { idempotencyKey?: string };

/** Отказ Платформы или транспорта после всех попыток. `status` 0 — ответа не было. */
export class PaoCallError extends Error {
  constructor(
    readonly status: number,
    readonly body: PaoErrorBody | undefined,
    readonly attempts: number,
    readonly idempotencyKey?: string,
    options?: { cause?: unknown },
  ) {
    super(body ? `${body.code}: ${body.message}` : `PAO_HTTP_${status}`, options);
  }
  get code(): ErrorCode | undefined { return this.body?.code; }
  /** Что делать вызывающему (AGENT-PROTOCOL.md §6). `new_key` — нужен новый ключ подписи агента. */
  get retry(): RetryAdvice { return this.body?.retry ?? "never"; }
}

export interface PaoClientOptions {
  baseUrl: string;
  agentCode: string;
  signer: Signer;
  /** Всего попыток на вызов, включая первую. */
  maxAttempts?: number;
  /** Пауза перед попыткой n+1, если Платформа не прислала Retry-After. */
  backoffMs?: (attempt: number) => number;
  /** Потолок ожидания по Retry-After, секунд. Больше — отказ вызывающему. */
  maxRetryAfterSec?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  nonce?: () => string;
  idempotencyKey?: () => string;
  /** Точка расширения: проверка ответа (Platform-Signature — позже, SEC-1/PS-05). Исключение отклоняет ответ. */
  inspectResponse?: (r: { op: PaoOperationKey; status: number; headers: Headers; body: string }) => void;
}

/** Клиент ПАО: подпись каждого обращения, Idempotency-Key для изменяющих методов, повторы.
 *  Повтор с тем же Idempotency-Key, новыми nonce и подписью — при `retry: same_key`, сбое сети,
 *  429/503 с Retry-After. Остальные отказы — вызывающему как PaoCallError. */
export class PaoClient {
  private readonly o: Required<Omit<PaoClientOptions, "inspectResponse">> & Pick<PaoClientOptions, "inspectResponse">;

  constructor(opts: PaoClientOptions) {
    this.o = {
      maxAttempts: 3,
      backoffMs: (n) => 200 * 2 ** (n - 1),
      maxRetryAfterSec: 30,
      fetch: globalThis.fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => new Date(),
      nonce: () => randomUUID(),
      idempotencyKey: () => randomUUID(),
      ...opts,
      baseUrl: trimTrailingSlashes(opts.baseUrl),
    };
  }

  async call<K extends PaoOperationKey>(op: K, args: PaoCallArgs<K>): Promise<PaoOperations[K]["response"]> {
    const spec = PAO_OPERATIONS[op];
    const a = args as { path?: Record<string, string>; query?: Record<string, string | undefined>; body?: unknown; idempotencyKey?: string };
    const path = spec.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const v = a.path?.[name];
      if (v === undefined) throw new Error(`PAO_PATH_PARAM ${name}`);
      return encodeURIComponent(v);
    });
    const qs = new URLSearchParams();
    for (const q of spec.query) {
      const v = a.query?.[q.name];
      if (v !== undefined) qs.append(q.name, v);
      else if (q.required) throw new Error(`PAO_QUERY_PARAM ${q.name}`);
    }
    const query = qs.toString();
    // У GET тела нет: content-digest — от пустой строки, чтобы состав подписи был одинаков для всех методов.
    const body = spec.body !== undefined ? canonicalJson(a.body) : "";
    const key = spec.idempotent ? (a.idempotencyKey ?? this.o.idempotencyKey()) : undefined;

    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = {
        "x-agent-code": this.o.agentCode,
        "x-timestamp": this.o.now().toISOString().slice(0, 19) + "Z",
        "x-nonce": this.o.nonce(),
      };
      if (key) headers["idempotency-key"] = key;
      if (spec.body !== undefined) headers["content-type"] = "application/json";
      const signed = spec.signed
        ? signRequest({ method: spec.method, path, query, headers, body }, this.o.signer).headers
        : headers;
      const last = attempt >= this.o.maxAttempts;

      let res: Response;
      try {
        res = await this.o.fetch(this.o.baseUrl + path + (query ? `?${query}` : ""), {
          method: spec.method,
          headers: signed,
          body: spec.method === "GET" ? undefined : body,
        });
      } catch (cause) {
        if (last) throw new PaoCallError(0, undefined, attempt, key, { cause });
        await this.o.sleep(this.o.backoffMs(attempt));
        continue;
      }

      const text = await res.text();
      if (res.ok) {
        this.o.inspectResponse?.({ op, status: res.status, headers: res.headers, body: text });
        return (text ? JSON.parse(text) : undefined) as PaoOperations[K]["response"];
      }

      const err = parseError(text);
      const retryAfter = res.status === 429 || res.status === 503 ? parseRetryAfter(res.headers.get("retry-after"), this.o.now()) : undefined;
      const transient = retryAfter !== undefined && retryAfter <= this.o.maxRetryAfterSec;
      if (last || !(transient || err?.retry === "same_key")) throw new PaoCallError(res.status, err, attempt, key);
      await this.o.sleep(transient ? retryAfter * 1000 : this.o.backoffMs(attempt));
    }
  }
}

function parseError(text: string): PaoErrorBody | undefined {
  try {
    const v = JSON.parse(text) as Partial<PaoErrorBody>;
    return typeof v?.code === "string" && typeof v.retry === "string" ? (v as PaoErrorBody) : undefined;
  } catch {
    return undefined;
  }
}

/** Retry-After: секунды или HTTP-дата. */
function parseRetryAfter(v: string | null, now: Date): number | undefined {
  if (v === null) return undefined;
  const s = v.trim();
  if (s === "") return undefined;
  if (isDigits(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now.getTime()) / 1000)) : undefined;
}

const isDigits = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 48 || s.charCodeAt(i) > 57) return false;
  return true;
};

/** Без регулярного выражения: `/\/+$/` на длинной строке из «/» перебирает за квадратичное время (CodeQL js/polynomial-redos). */
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}
