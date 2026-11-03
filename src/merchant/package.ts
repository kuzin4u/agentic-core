// Пакет агентской оплаты — PaymentPackage (РП22 п. 5, AGENT-PROTOCOL §4 платформы; К25 п. 6–7). Схема — в ПАО 1.5.0;
// до неё тип здесь, разбор повторяет parsePaymentPackage платформы (src/env/acquirer/package.ts): две реализации не
// расходятся. Суммы в пакете нет: сумма операции — только из заказа продавца и сообщения процессинга (инвариант 5).
import type { Aoi } from "../pao/types.js";

export interface PaymentPackage {
  readonly credential_ref: string;
  readonly kind: "CARD" | "SBP";
  /** криптограмма агентского токена или идентификатор списания по привязке; номера карты нет */
  readonly payload: {
    readonly token_ref?: string;
    readonly cryptogram?: string;
    readonly account_link_ref?: string;
    /** строка без проверки даты, как у платформы (К25 развилки: к пересмотру по К20) */
    readonly valid_to?: string;
  };
  readonly aoi: Readonly<Aoi> & { readonly indicator: true };
  readonly cart_mandate_id: string;
  /** ссылка продавца на заказ */
  readonly order_ref: string;
}

/** Признак агентской операции для эквайрера (К25 п. 7): `aoi` — в авторизацию (ПИ-2), всё — в сверку по ПИ-8. */
export interface AcquirerMetadata {
  readonly credential_ref: string;
  readonly order_ref: string;
  readonly aoi: PaymentPackage["aoi"];
}

const str = (v: unknown): v is string => typeof v === "string" && v !== "";
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

function optStr(o: Record<string, unknown>, k: string): string | undefined | null {
  const v = own(o, k);
  return v === undefined ? undefined : str(v) ? v : null;
}

/**
 * Строгий разбор пакета: читаются только поля PaymentPackage, прочие (в том числе сумма) не переносятся.
 * Неполный пакет, вид реквизита вне перечня, payload не по виду — null (fail-closed).
 */
export function parsePaymentPackage(input: unknown): PaymentPackage | null {
  if (!obj(input)) return null;
  const credential_ref = own(input, "credential_ref");
  const kind = own(input, "kind");
  const cart_mandate_id = own(input, "cart_mandate_id");
  const order_ref = own(input, "order_ref");
  const p = own(input, "payload");
  const a = own(input, "aoi");
  if (!str(credential_ref) || !str(cart_mandate_id) || !str(order_ref) || !obj(p) || !obj(a)) return null;
  if (kind !== "CARD" && kind !== "SBP") return null;

  const token_ref = optStr(p, "token_ref");
  const cryptogram = optStr(p, "cryptogram");
  const account_link_ref = optStr(p, "account_link_ref");
  const valid_to = optStr(p, "valid_to");
  if (token_ref === null || cryptogram === null || account_link_ref === null || valid_to === null) return null;
  if (kind === "CARD" && (!token_ref || !cryptogram || account_link_ref)) return null;
  if (kind === "SBP" && (!account_link_ref || token_ref || cryptogram)) return null;

  const agent_code = own(a, "agent_code");
  const mandate_id = own(a, "mandate_id");
  if (own(a, "indicator") !== true || !str(agent_code) || !str(mandate_id)) return null;
  const fulfilment_ref = own(a, "fulfilment_ref");
  const deal_ref = own(a, "deal_ref");
  if (fulfilment_ref !== undefined && fulfilment_ref !== null && !str(fulfilment_ref)) return null;
  if (deal_ref !== undefined && deal_ref !== null && !str(deal_ref)) return null;

  return {
    credential_ref,
    kind,
    payload: {
      ...(token_ref ? { token_ref } : {}),
      ...(cryptogram ? { cryptogram } : {}),
      ...(account_link_ref ? { account_link_ref } : {}),
      ...(valid_to ? { valid_to } : {}),
    },
    aoi: {
      indicator: true,
      agent_code,
      mandate_id,
      ...(fulfilment_ref !== undefined ? { fulfilment_ref: fulfilment_ref as string | null } : {}),
      ...(deal_ref !== undefined ? { deal_ref: deal_ref as string | null } : {}),
    },
    cart_mandate_id,
    order_ref,
  };
}

/** Признак агентской операции и метаданные пакета для эквайрера; сумма и payload не передаются. */
export function acquirerMetadata(pkg: PaymentPackage): AcquirerMetadata {
  return { credential_ref: pkg.credential_ref, order_ref: pkg.order_ref, aoi: { ...pkg.aoi } };
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Тело пакета: байты — строгий UTF-8 (BOM не снимается, К22 п. 4), затем JSON и разбор. Иначе null. */
export function decodePaymentPackage(body: string | Uint8Array | undefined): PaymentPackage | null {
  if (body === undefined) return null;
  let text: string;
  if (typeof body === "string") text = body;
  else {
    try { text = STRICT_UTF8.decode(body); } catch { return null; }
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  return parsePaymentPackage(value);
}
