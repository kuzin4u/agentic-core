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
const holds = [
  { op: ["open", "MND-1", 500000], available: 500000 },
  { op: ["reserve", "MND-1", 189000, "OP-1"], available: 311000 },
  { op: ["reserve", "MND-1", 340000, "OP-2"], error: "INSUFFICIENT", available: 311000 },
  { op: ["commit", "OP-1", 150000, true], available: 350000 },
  { op: ["reserve", "MND-1", 100000, "OP-3", 1000], available: 250000 },
  { op: ["expire", 2000], available: 350000 },
  { op: ["reserve", "MND-1", 50000, "OP-4"], available: 300000 },
  { op: ["release", "OP-4"], available: 350000 },
  { op: ["release", "OP-4"], available: 350000 },
  { op: ["commit", "OP-4", 1000], error: "BAD_STATE", available: 350000 },
];
writeFileSync(new URL("./vectors.json", import.meta.url), JSON.stringify({ version: 1, canonical, journal, holds }, null, 2));
console.log("vectors written");
