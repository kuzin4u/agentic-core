import { generateKeyPairSync, sign as cSign, verify as cVerify, createPublicKey, KeyObject } from "node:crypto";
import { createHash } from "node:crypto";
import { isWeakEd25519 } from "./ed25519.js";
import { nonceStoreOptions } from "./nonce-options.js";

/** Подпись HTTP-обращений (схема HTTP Message Signatures, упрощённый профиль).
 *  Алгоритм — атрибут ключа: ed25519 в песочнице; ГОСТ — точка расширения через интерфейс Signer. */
export const DEFAULT_COMPONENTS = ["@method", "@path", "@query", "content-digest", "x-agent-code", "x-timestamp", "x-nonce"] as const;

export interface HttpLike { method: string; path: string; query?: string; headers: Record<string, string>; body?: string; }

export function contentDigest(body: string): string {
  return "sha-256=:" + createHash("sha256").update(body).digest("base64") + ":";
}

export function signatureBase(req: HttpLike, components: readonly string[] = DEFAULT_COMPONENTS): string {
  const h = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
  return components.map((c) => {
    if (c === "@method") return `"@method": ${req.method.toUpperCase()}`;
    if (c === "@path") return `"@path": ${req.path}`;
    if (c === "@query") return `"@query": ?${req.query ?? ""}`;
    const v = h[c];
    if (v === undefined) throw new Error(`MISSING_COMPONENT ${c}`);
    return `"${c}": ${v}`;
  }).join("\n");
}

export interface Signer { kid: string; alg: string; sign(data: Buffer): Buffer; }
export interface Verifier { verify(alg: string, publicKey: string, data: Buffer, sig: Buffer): boolean; }

export function newEd25519Signer(kid: string): { signer: Signer; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { signer: { kid, alg: "ed25519", sign: (d) => cSign(null, d, privateKey) }, publicKey: pub };
}

// DER SubjectPublicKeyInfo Ed25519 (RFC 8410): 12 байт заголовка + 32 байта точки.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Строгий разбор открытого ключа: канонический base64 (RFC 4648 §3.5), DER ровно 44 байта, точка не слабая. Иначе null. */
function parseEd25519PublicKey(publicKey: string): KeyObject | null {
  const der = Buffer.from(publicKey, "base64");
  if (der.length !== 44 || der.toString("base64") !== publicKey) return null;
  if (!der.subarray(0, 12).equals(ED25519_SPKI_PREFIX) || isWeakEd25519(der.subarray(12))) return null;
  try { return createPublicKey({ key: der, format: "der", type: "spki" }); } catch { return null; }
}

export const ed25519Verifier: Verifier = {
  verify(alg, publicKey, data, sig) {
    if (alg !== "ed25519") return false;
    const key = parseEd25519PublicKey(publicKey);
    if (!key) return false;
    try { return cVerify(null, data, key, sig); } catch { return false; }
  },
};

export function signRequest(req: HttpLike, signer: Signer, components: readonly string[] = DEFAULT_COMPONENTS): HttpLike {
  const headers = { ...req.headers };
  if (req.body !== undefined) headers["content-digest"] = contentDigest(req.body);
  const withDigest = { ...req, headers };
  const base = signatureBase(withDigest, components);
  const list = components.map((c) => `"${c}"`).join(" ");
  headers["signature-input"] = `sig1=(${list});keyid="${signer.kid}";alg="${signer.alg}"`;
  headers["signature"] = `sig1=:${signer.sign(Buffer.from(base)).toString("base64")}:`;
  return { ...req, headers };
}

export type VerifyResult = { ok: true; kid: string } | { ok: false; code: "SIGNATURE_INVALID" | "AGENT_KEY_REVOKED" };

/** Проверка: состав полей, digest тела, окно времени, неповтор nonce, статус ключа. */
export function verifyRequest(
  req: HttpLike,
  lookupKey: (kid: string) => { alg: string; publicKey: string; status: "ACTIVE" | "REVOKED" | "EXPIRED" } | undefined,
  opts: { now: number; skewSec: number; seenNonce: (n: string) => boolean; verifier?: Verifier },
): VerifyResult {
  const h = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const m = /^sig1=\(([^)]*)\);keyid="([^"]+)";alg="([^"]+)"$/.exec(h["signature-input"] ?? "");
  const s = /^sig1=:([^:]+):$/.exec(h["signature"] ?? "");
  if (!m || !s) return { ok: false, code: "SIGNATURE_INVALID" };
  const components = m[1]!.split(" ").map((x) => x.replace(/"/g, ""));
  for (const req_c of DEFAULT_COMPONENTS) if (!components.includes(req_c)) return { ok: false, code: "SIGNATURE_INVALID" };
  if (req.body !== undefined && h["content-digest"] !== contentDigest(req.body)) return { ok: false, code: "SIGNATURE_INVALID" };
  const ts = Date.parse(h["x-timestamp"] ?? "");
  if (!Number.isFinite(ts) || Math.abs(opts.now - ts) > opts.skewSec * 1000) return { ok: false, code: "SIGNATURE_INVALID" };
  if (opts.seenNonce(h["x-nonce"] ?? "")) return { ok: false, code: "SIGNATURE_INVALID" };
  const key = lookupKey(m[2]!);
  if (!key) return { ok: false, code: "SIGNATURE_INVALID" };
  if (key.status !== "ACTIVE") return { ok: false, code: "AGENT_KEY_REVOKED" };
  let base: string;
  try { base = signatureBase(req, components); } catch { return { ok: false, code: "SIGNATURE_INVALID" }; }
  const v = (opts.verifier ?? ed25519Verifier).verify(m[3]!, key.publicKey, Buffer.from(base), Buffer.from(s[1]!, "base64"));
  return v ? { ok: true, kid: m[2]! } : { ok: false, code: "SIGNATURE_INVALID" };
}

type KeyRecord = { alg: string; publicKey: string; status: "ACTIVE" | "REVOKED" | "EXPIRED" };

/** Как verifyRequest, но nonce и ключ — из асинхронных хранилищ (К6 п. 13). nonce проверяется последним, после подписи:
 *  в хранилище попадают только nonce подписанных обращений. Отличие кодов от verifyRequest: повтор nonce с отозванным
 *  ключом — AGENT_KEY_REVOKED, а не SIGNATURE_INVALID. */
export async function verifyRequestAsync(
  req: HttpLike,
  lookupKey: (kid: string) => KeyRecord | undefined | Promise<KeyRecord | undefined>,
  opts: { now: number; skewSec: number; seenNonce: (n: string) => Promise<boolean>; verifier?: Verifier },
): Promise<VerifyResult> {
  const h = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const m = /^sig1=\(([^)]*)\);keyid="([^"]+)";alg="([^"]+)"$/.exec(h["signature-input"] ?? "");
  const s = /^sig1=:([^:]+):$/.exec(h["signature"] ?? "");
  if (!m || !s) return { ok: false, code: "SIGNATURE_INVALID" };
  const components = m[1]!.split(" ").map((x) => x.replace(/"/g, ""));
  for (const req_c of DEFAULT_COMPONENTS) if (!components.includes(req_c)) return { ok: false, code: "SIGNATURE_INVALID" };
  if (req.body !== undefined && h["content-digest"] !== contentDigest(req.body)) return { ok: false, code: "SIGNATURE_INVALID" };
  const ts = Date.parse(h["x-timestamp"] ?? "");
  if (!Number.isFinite(ts) || Math.abs(opts.now - ts) > opts.skewSec * 1000) return { ok: false, code: "SIGNATURE_INVALID" };
  const key = await lookupKey(m[2]!);
  if (!key) return { ok: false, code: "SIGNATURE_INVALID" };
  if (key.status !== "ACTIVE") return { ok: false, code: "AGENT_KEY_REVOKED" };
  let base: string;
  try { base = signatureBase(req, components); } catch { return { ok: false, code: "SIGNATURE_INVALID" }; }
  const v = (opts.verifier ?? ed25519Verifier).verify(m[3]!, key.publicKey, Buffer.from(base), Buffer.from(s[1]!, "base64"));
  if (!v) return { ok: false, code: "SIGNATURE_INVALID" };
  if (await opts.seenNonce(h["x-nonce"] ?? "")) return { ok: false, code: "SIGNATURE_INVALID" };
  return { ok: true, kid: m[2]! };
}

/** Использованные nonce (К6 п. 12). seen — проверка и запись одной операцией: true, если nonce уже был (или пуст).
 *  purge — удалить старше retainMs; retainMs ≥ 2 × окна времени проверки: обращение с меткой на краю окна
 *  принимается ещё skewSec после записи nonce, и его повтор должен быть отвергнут. */
export interface AsyncNonceStore {
  seen(nonce: string): Promise<boolean>;
  purge(): Promise<number>;
}

export interface NonceStoreOptions {
  /** Сколько хранить nonce, мс; не меньше 2 × skewSec × 1000. */
  retainMs: number;
  /** Окно времени проверки (skewSec у verifyRequest/verifyRequestAsync): если передано — retainMs проверяется. */
  skewSec?: number;
  now?: () => number;
}

export class MemoryNonceStore implements AsyncNonceStore {
  private rows = new Map<string, number>();
  private o: { retainMs: number; now: () => number };
  constructor(opts: NonceStoreOptions) { this.o = nonceStoreOptions(opts); }
  async seen(nonce: string): Promise<boolean> {
    if (!nonce || this.rows.has(nonce)) return true;
    this.rows.set(nonce, this.o.now());
    return false;
  }
  async purge(): Promise<number> {
    const before = this.o.now() - this.o.retainMs;
    let n = 0;
    for (const [k, at] of this.rows) if (at < before) { this.rows.delete(k); n++; }
    return n;
  }
}
