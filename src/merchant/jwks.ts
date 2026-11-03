// Каталог ключей агентов для продавца — JWKS (RFC 7517), ключ — JWK по RFC 8037 (РП22 п. 1 платформы; К25 п. 2).
// Разбор строгий. Ключ не по форме пропускается: для продавца это «неизвестный kid» (fail-closed по ключу,
// MERCHANT-API §2). Тело не объект с массивом keys — каталог не принят.
import { createHash } from "node:crypto";
import { isWeakEd25519 } from "../ed25519.js";

/** Ключ агента из каталога после проверки формы. */
export interface AgentJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
  readonly alg: "EdDSA";
  readonly use: "sig";
  /** отпечаток RFC 7638 от {crv, kty, x} — тот же, что keyid подписи и Key.kid ПАО */
  readonly kid: string;
  /** код агента, которому принадлежит ключ (частный член, RFC 7517 §4) */
  readonly agent_code: string;
  /** срок ключа, секунды Unix (частные члены) */
  readonly nbf: number;
  readonly exp: number;
}

/** Итог разбора каталога: принятые ключи и число пропущенных (в диагностику набора, К25 п. 2). */
export interface ParsedAgentJwks {
  readonly keys: ReadonlyMap<string, AgentJwk>;
  readonly skipped: number;
}

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const KID = /^[A-Za-z0-9_-]{43}$/;
/** Начало DER SubjectPublicKeyInfo Ed25519 (RFC 8410): за ним 32 байта точки. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

/** Отпечаток JWK Ed25519 по RFC 7638: члены по возрастанию имён, JSON без пробелов, SHA-256, base64url без дополнения. */
export function okpThumbprint(x: string): string {
  return createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest("base64url");
}

/** 32 байта точки из канонического base64url без дополнения; иначе null. */
function point(x: unknown): Buffer | null {
  if (typeof x !== "string" || !B64URL_32.test(x)) return null;
  const b = Buffer.from(x, "base64url");
  return b.length === 32 && b.toString("base64url") === x ? b : null;
}

/** Ключ по форме К25 п. 2 или null. */
function parseKey(v: unknown): AgentJwk | null {
  if (!isObj(v)) return null;
  if (own(v, "kty") !== "OKP" || own(v, "crv") !== "Ed25519" || own(v, "alg") !== "EdDSA" || own(v, "use") !== "sig") return null;
  const x = own(v, "x");
  const p = point(x);
  if (!p || isWeakEd25519(p)) return null;
  const kid = own(v, "kid");
  if (typeof kid !== "string" || !KID.test(kid) || kid !== okpThumbprint(x as string)) return null;
  const agent_code = own(v, "agent_code");
  if (typeof agent_code !== "string" || agent_code === "") return null;
  const nbf = own(v, "nbf");
  const exp = own(v, "exp");
  if (!Number.isSafeInteger(nbf) || !Number.isSafeInteger(exp) || (nbf as number) >= (exp as number)) return null;
  return Object.freeze({ kty: "OKP", crv: "Ed25519", x: x as string, alg: "EdDSA", use: "sig", kid, agent_code, nbf: nbf as number, exp: exp as number });
}

/** Строгий разбор тела каталога. null — каталог не принят (не объект или нет массива keys). */
export function parseAgentJwks(body: unknown): ParsedAgentJwks | null {
  if (!isObj(body)) return null;
  const list = own(body, "keys");
  if (!Array.isArray(list)) return null;
  const keys = new Map<string, AgentJwk>();
  const dup = new Set<string>();
  let skipped = 0;
  for (const item of list) {
    const k = parseKey(item);
    if (!k) { skipped++; continue; }
    if (dup.has(k.kid)) { skipped++; continue; }
    if (keys.has(k.kid)) { keys.delete(k.kid); dup.add(k.kid); skipped += 2; continue; }
    keys.set(k.kid, k);
  }
  return { keys, skipped };
}

/** Открытый ключ JWK в DER SPKI base64 — вход ed25519Verifier. */
export function jwkSpki(jwk: AgentJwk): string {
  return Buffer.concat([SPKI_PREFIX, Buffer.from(jwk.x, "base64url")]).toString("base64");
}
