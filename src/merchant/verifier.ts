// Проверка обращения агента у продавца (К25 п. 3–5; РП22 п. 2–3, MERCHANT-API §3–4 платформы).
// Каталог ключей — через порт потребителя, HTTP в ядре нет. Подпись — по байтам тела (К22).
import { ed25519Verifier, verifyRequestAsync, type AsyncNonceStore, type HttpLike, type Verifier } from "../signing.js";
import { jwkSpki, parseAgentJwks, type AgentJwk } from "./jwks.js";

/** Порт каталога: тело ответа `/.well-known/agent-keys` и `max-age` из `Cache-Control` (К25 п. 3). */
export type AgentKeySource = () => Promise<{ body: unknown; maxAgeSec?: number }>;

/** Коды отказа проверки обращения (реестр `MERCHANT_DIAG`). */
export type MerchantAuthCode = "KEY_UNKNOWN" | "AGENT_MISMATCH" | "KEY_EXPIRED" | "SIGNATURE_INVALID" | "KEYS_UNAVAILABLE";

export type MerchantAuthResult =
  /** ни одного заголовка агента — обращение человека; продавец обслуживает его по своим правилам */
  | { readonly kind: "unsigned" }
  | { readonly kind: "agent"; readonly agentCode: string; readonly kid: string }
  | { readonly kind: "refused"; readonly code: MerchantAuthCode };

export interface MerchantVerifierOptions {
  /** окно `x-timestamp`, с (`signature_skew_sec` Платформы); обязательно */
  readonly skewSec: number;
  /** использованные nonce; `retainMs ≥ 2 × skewSec`; область — по агенту (ключ `agent_code` + `\0` + nonce) */
  readonly nonces: AsyncNonceStore;
  /** срок кэша, если порт не дал `maxAgeSec`; по умолчанию 300 (`merchant_jwks_max_age_sec`, MERCHANT-API §4) */
  readonly defaultMaxAgeSec?: number;
  /** не чаще одного перечитывания по неизвестному kid; по умолчанию 30 (`merchant_jwks_refetch_min_sec`, РП22 п. 3) */
  readonly refetchMinSec?: number;
  /** часы, мс Unix */
  readonly now?: () => number;
  readonly verifier?: Verifier;
}

/** Состояние каталога — в диагностику набора (К25 п. 2). */
export interface MerchantCatalogState {
  /** число попыток чтения каталога */
  readonly fetches: number;
  /** принятых ключей в кэше */
  readonly keys: number;
  /** пропущено ключей не по форме при последнем успешном чтении */
  readonly skipped: number;
  /** время последней попытки чтения, мс; null — чтений не было */
  readonly fetchedAt: number | null;
  /** последняя попытка чтения не удалась */
  readonly failed: boolean;
}

/** Заголовки, по которым обращение называет себя агентом (поправка 2 владельца к К25). */
export const AGENT_HEADERS = ["x-agent-code", "signature", "signature-input", "content-digest"] as const;

const SIG_INPUT = /^sig1=\(([^)]*)\);keyid="([^"]+)";alg="([^"]+)"$/;
const EMPTY = new Uint8Array(0);

const nonNegInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export class MerchantAgentVerifier {
  readonly #source: AgentKeySource;
  readonly #o: Required<Omit<MerchantVerifierOptions, "verifier">> & { verifier: Verifier };
  #keys: ReadonlyMap<string, AgentJwk> = new Map();
  #fetchedAt = Number.NEGATIVE_INFINITY;
  #maxAgeMs: number;
  #fetches = 0;
  #skipped = 0;
  #failed = false;
  #inflight: Promise<boolean> | null = null;

  constructor(source: AgentKeySource, opts: MerchantVerifierOptions) {
    const o = {
      skewSec: opts.skewSec,
      nonces: opts.nonces,
      defaultMaxAgeSec: opts.defaultMaxAgeSec ?? 300,
      refetchMinSec: opts.refetchMinSec ?? 30,
      now: opts.now ?? Date.now,
      verifier: opts.verifier ?? ed25519Verifier,
    };
    if (!(Number.isFinite(o.skewSec) && o.skewSec > 0)) throw new RangeError("skewSec — положительное число секунд");
    if (!nonNegInt(o.defaultMaxAgeSec)) throw new RangeError("defaultMaxAgeSec — целое число секунд ≥ 0");
    if (!nonNegInt(o.refetchMinSec)) throw new RangeError("refetchMinSec — целое число секунд ≥ 0");
    this.#source = source;
    this.#o = o;
    this.#maxAgeMs = o.defaultMaxAgeSec * 1000;
  }

  catalog(): MerchantCatalogState {
    return {
      fetches: this.#fetches,
      keys: this.#keys.size,
      skipped: this.#skipped,
      fetchedAt: Number.isFinite(this.#fetchedAt) ? this.#fetchedAt : null,
      failed: this.#failed,
    };
  }

  /** Одно чтение на всех ожидающих. false — сбой: кэш очищен, как у платформы (К25 п. 4, развилка к пересмотру). */
  #refresh(nowMs: number): Promise<boolean> {
    if (this.#inflight) return this.#inflight;
    this.#fetchedAt = nowMs;
    this.#fetches++;
    const run = (async () => {
      try {
        const r = await this.#source();
        const parsed = parseAgentJwks(r?.body);
        if (!parsed) throw new Error("каталог не принят");
        this.#keys = parsed.keys;
        this.#skipped = parsed.skipped;
        this.#maxAgeMs = (nonNegInt(r.maxAgeSec) ? r.maxAgeSec : this.#o.defaultMaxAgeSec) * 1000;
        this.#failed = false;
        return true;
      } catch {
        this.#keys = new Map();
        this.#failed = true;
        return false;
      } finally {
        this.#inflight = null;
      }
    })();
    this.#inflight = run;
    return run;
  }

  async verify(req: HttpLike): Promise<MerchantAuthResult> {
    const h = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (AGENT_HEADERS.every((n) => h[n] === undefined)) return { kind: "unsigned" };
    const m = SIG_INPUT.exec(h["signature-input"] ?? "");
    const agentCode = h["x-agent-code"];
    if (!m || h["signature"] === undefined || !agentCode) return refused("SIGNATURE_INVALID");
    const kid = m[2]!;

    const nowMs = this.#o.now();
    if (this.#inflight) {
      if (!(await this.#inflight)) return refused("KEYS_UNAVAILABLE");
    } else if (nowMs - this.#fetchedAt >= this.#maxAgeMs) {
      if (!(await this.#refresh(nowMs))) return refused("KEYS_UNAVAILABLE");
    } else if (!this.#keys.has(kid) && nowMs - this.#fetchedAt >= this.#o.refetchMinSec * 1000) {
      if (!(await this.#refresh(nowMs))) return refused("KEYS_UNAVAILABLE");
    }
    const jwk = this.#keys.get(kid);
    if (!jwk) return refused("KEY_UNKNOWN");
    if (jwk.agent_code !== agentCode) return refused("AGENT_MISMATCH");
    if (nowMs < jwk.nbf * 1000 || nowMs >= jwk.exp * 1000) return refused("KEY_EXPIRED");

    const r = await verifyRequestAsync(
      { ...req, headers: h, body: req.body ?? EMPTY },
      (k) => (k === kid ? { alg: "ed25519", publicKey: jwkSpki(jwk), status: "ACTIVE" } : undefined),
      {
        now: nowMs,
        skewSec: this.#o.skewSec,
        seenNonce: (n) => (n === "" ? Promise.resolve(true) : this.#o.nonces.seen(`${agentCode}\u0000${n}`)),
        verifier: this.#o.verifier,
      },
    );
    return r.ok ? { kind: "agent", agentCode, kid } : refused("SIGNATURE_INVALID");
  }
}

const refused = (code: MerchantAuthCode): MerchantAuthResult => ({ kind: "refused", code });
