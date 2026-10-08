import { generateKeyPairSync, sign as cSign, verify as cVerify, createPublicKey, KeyObject } from "node:crypto";
import { createHash } from "node:crypto";

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

export const ed25519Verifier: Verifier = {
  verify(alg, publicKey, data, sig) {
    if (alg !== "ed25519") return false;
    const key: KeyObject = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    return cVerify(null, data, key, sig);
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
