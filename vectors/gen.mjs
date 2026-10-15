// Генератор тестовых векторов. Запускать после изменения алгоритмов: node vectors/gen.mjs
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
const canon = (v) => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : "{" + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const canonical = [
  { input: { b: 2, a: 1 } },
  { input: { aoi: { mandate_id: "MND-8f31c0", agent_code: "nspk:agent:buyref-01:v3", indicator: true }, amount: 189000, currency: "RUB" } },
  { input: ["я", { z: null, "ю": [1, 2] }] },
].map((x) => ({ ...x, canonical: canon(x.input), sha256: sha(canon(x.input)) }));
const at = "2026-10-08T00:00:00.000Z";
const e1b = { seq: 1, at, kind: "mandate", ref: "MND-1", parent_ref: null, payload: { amount_limit: 500000 }, prev_hash: "0".repeat(64) };
const h1 = sha(canon(e1b));
const e2b = { seq: 2, at, kind: "mandate", ref: "MND-2", parent_ref: "MND-1", payload: { amount_limit: 189000 }, prev_hash: h1 };
const journal = [{ ...e1b, hash: h1 }, { ...e2b, hash: sha(canon(e2b)) }];
// Начало именованной цепочки (К6 п. 8): sha256("core_journal:" + chain), UTF-8 без нормализации Unicode.
// «й» одним кодом (NFC) и «и» + краткая (NFD) дают разные начала — правило закреплено вектором.
const journal_chain_genesis = ["mandates:client-42", "журнал-сделок", "\u0439", "\u0438\u0306"].map((chain) => ({
  chain, chain_utf8_hex: Buffer.from(chain, "utf8").toString("hex"), genesis: sha("core_journal:" + chain),
}));
// Суммы (К9): целые минимальные единицы + код валюты; ожидания считаются здесь отдельно от src, через BigInt.
const M = Number.MAX_SAFE_INTEGER;
const CUR = /^[A-Z][A-Z0-9]{2,11}$/;
const m = (amount, currency) => ({ amount, currency });
const valid = (x) => Number.isSafeInteger(x.amount) && x.amount >= 0 && CUR.test(x.currency);
const err = (x) => !Number.isSafeInteger(x.amount) || x.amount < 0 ? "BAD_AMOUNT" : "BAD_CURRENCY";
const vMoney = (a) => valid(a) ? { result: a } : { error: err(a) };
const vAdd = (a, b) => {
  for (const x of [a, b]) if (!valid(x)) return { error: err(x) };
  if (a.currency !== b.currency) return { error: "CURRENCY_MISMATCH" };
  const s = a.amount + b.amount;
  return Number.isSafeInteger(s) ? { result: m(s, a.currency) } : { error: "BAD_AMOUNT" };
};
const vSplit = (t, w) => {
  if (!valid(t)) return { error: err(t) };
  if (w.length === 0 || !w.every((x) => Number.isSafeInteger(x) && x >= 0)) return { error: "BAD_WEIGHTS" };
  const sum = w.reduce((a, x) => a + BigInt(x), 0n);
  if (sum === 0n) return { error: "BAD_WEIGHTS" };
  const parts = w.map((x) => (BigInt(t.amount) * BigInt(x)) / sum);
  let last = w.length - 1; while (w[last] === 0) last--;
  parts[last] += BigInt(t.amount) - parts.reduce((a, b) => a + b, 0n);
  return { result: parts.map((p) => m(Number(p), t.currency)) };
};
const money = [
  ...[m(189000, "RUB"), m(1500, "JPY"), m(12345, "KWD"), m(2500000, "USDC"), m(0, "RUB"), m(M, "USDC"),
    m(M + 1, "RUB"), m(-1, "RUB"), m(1.5, "RUB"), m(1, "rub"), m(1, "RU"), m(1, "1AB")].map((a) => ({ op: "money", args: [a], ...vMoney(a) })),
  ...[[m(150, "JPY"), m(50, "JPY")], [m(M - 2, "USDC"), m(2, "USDC")], [m(M, "RUB"), m(1, "RUB")], [m(100, "RUB"), m(100, "USD")],
    [m(1, "KWD"), m(1, "kwd")]].map((args) => ({ op: "add", args, ...vAdd(...args) })),
  ...[[m(100001, "RUB"), [1, 1, 1]], [m(5, "RUB"), [1, 1, 0]], [m(7, "KWD"), [0, 3, 0, 0]], [m(1000000, "USDC"), [2500, 7500]],
    [m(M, "USDC"), [3, 1]], [m(10, "RUB"), [0, 0]], [m(10, "RUB"), [0.5, 0.5]], [m(10, "RUB"), []]]
    .map((args) => ({ op: "split", args, ...vSplit(...args) })),
];
// Удержания (К9 пп. 5–6): суммы с валютой; available — Money.
const R = (n) => m(n, "RUB");
const holds = [
  { op: ["open", "MND-1", R(500000)], available: R(500000) },
  { op: ["reserve", "MND-1", R(189000), "OP-1"], available: R(311000) },
  { op: ["reserve", "MND-1", R(340000), "OP-2"], error: "INSUFFICIENT", available: R(311000) },
  { op: ["reserve", "MND-1", m(1000, "USD"), "OP-USD"], error: "CURRENCY_MISMATCH", available: R(311000) },
  { op: ["reserve", "MND-1", m(189000, "USD"), "OP-1"], error: "REF_CONFLICT", available: R(311000) },
  { op: ["reserve", "MND-1", R(189000), "OP-1"], available: R(311000) },
  { op: ["open", "MND-1", R(500000)], available: R(311000) },
  { op: ["open", "MND-1", R(600000)], error: "ACCOUNT_CONFLICT", available: R(311000) },
  { op: ["open", "MND-1", m(500000, "USD")], error: "ACCOUNT_CONFLICT", available: R(311000) },
  { op: ["open", "MND-2", m(500000, "rub")], error: "BAD_CURRENCY", available: R(311000) },
  { op: ["reserve", "MND-1", m(1000, "rub"), "OP-rub"], error: "BAD_CURRENCY", available: R(311000) },
  { op: ["commit", "OP-1", m(150000, "USD"), true], error: "CURRENCY_MISMATCH", available: R(311000) },
  { op: ["commit", "OP-1", R(150000), true], available: R(350000) },
  { op: ["reserve", "MND-1", R(100000), "OP-3", 1000], available: R(250000) },
  { op: ["expire", 2000], available: R(350000) },
  { op: ["reserve", "MND-1", R(50000), "OP-4"], available: R(300000) },
  { op: ["release", "OP-4"], available: R(350000) },
  { op: ["release", "OP-4"], available: R(350000) },
  { op: ["commit", "OP-4", R(1000)], error: "BAD_STATE", available: R(350000) },
];
const out = JSON.stringify({ version: 2, canonical, journal, journal_chain_genesis, money, holds }, null, 2);
// Число 15–19 цифр, проходящее проверку Луна, сканер ключей и реквизитов примет за номер карты — такие векторы не пишем.
const luhn = (s) => [...s].reverse().reduce((a, c, i) => { let d = +c; if (i % 2) { d *= 2; if (d > 9) d -= 9; } return a + d; }, 0) % 10 === 0;
for (const n of out.match(/\d{15,19}/g) ?? []) if (new Set(n).size > 1 && luhn(n)) throw new Error(`число ${n.length} цифр проходит проверку Луна — замените вектор`);
writeFileSync(new URL("./vectors.json", import.meta.url), out);
console.log("vectors written");
