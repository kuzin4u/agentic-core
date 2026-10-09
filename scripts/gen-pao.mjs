// Генератор типов ПАО (К5): spec/agent-protocol.yaml → src/pao/types.ts.
// `node scripts/gen-pao.mjs` — записать; `--check` — сверить с файлом и хэшем в spec/SOURCE.md, не записывая.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "yaml";

const SPEC = "spec/agent-protocol.yaml";
const SOURCE = "spec/SOURCE.md";
const OUT = "src/pao/types.ts";

const raw = readFileSync(SPEC, "utf8");
const sha = createHash("sha256").update(raw).digest("hex");
const spec = parse(raw, { maxAliasCount: -1 });
const REF = "#/components/schemas/";

const refName = (ref) => {
  if (!ref.startsWith(REF)) throw new Error(`UNSUPPORTED_REF ${ref}`);
  return ref.slice(REF.length);
};
const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
const doc = (s, pad) => (s.description ? `${pad}/** ${s.description} */\n` : "");

function tsType(s, pad = "") {
  if (s.$ref) return refName(s.$ref);
  if (s.allOf) return s.allOf.map((x) => tsType(x, pad)).join(" & ");
  let t;
  if (s.enum) t = s.enum.map((v) => (v === null ? "null" : JSON.stringify(v))).join(" | ");
  else if (s.type === "string") t = "string";
  else if (s.type === "integer" || s.type === "number") t = "number";
  else if (s.type === "boolean") t = "boolean";
  else if (s.type === "array") t = `Array<${tsType(s.items, pad)}>`;
  else if (s.type === "object" || s.properties) t = objectType(s, pad);
  else throw new Error(`UNSUPPORTED_SCHEMA ${JSON.stringify(s)}`);
  if (s.nullable && !(s.enum ?? []).includes(null)) t += " | null";
  return t;
}

function objectType(s, pad) {
  if (!s.properties) {
    const ap = s.additionalProperties;
    return ap && typeof ap === "object" ? `Record<string, ${tsType(ap, pad)}>` : "Record<string, unknown>";
  }
  const req = new Set(s.required ?? []);
  const inner = pad + "  ";
  const lines = Object.entries(s.properties).map(
    ([k, p]) => `${doc(p, inner)}${inner}${key(k)}${req.has(k) ? "" : "?"}: ${tsType(p, inner)};`,
  );
  return `{\n${lines.join("\n")}\n${pad}}`;
}

function schemaDecl(name, s) {
  const body = tsType(s);
  const head = doc(s, "");
  return body.startsWith("{") && !s.nullable ? `${head}export interface ${name} ${body}` : `${head}export type ${name} = ${body};`;
}

const resolveParam = (p) => (p.$ref ? spec.components.parameters[p.$ref.split("/").pop()] : p);
const jsonSchema = (x) => x?.content?.["application/json"]?.schema;

const ops = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    const params = (op.parameters ?? []).map(resolveParam);
    const codes = Object.keys(op.responses);
    const success = codes.find((c) => c.startsWith("2"));
    ops.push({
      key: `${method.toUpperCase()} ${path}`,
      summary: op.summary,
      method: method.toUpperCase(),
      path,
      signed: params.some((p) => p.name === "Signature"),
      idempotent: params.some((p) => p.name === "Idempotency-Key"),
      success: Number(success),
      errors: codes.filter((c) => !c.startsWith("2")).map(Number),
      pathParams: params.filter((p) => p.in === "path").map((p) => p.name),
      query: params.filter((p) => p.in === "query").map((p) => ({ name: p.name, required: p.required === true })),
      body: jsonSchema(op.requestBody),
      response: jsonSchema(op.responses[success]),
    });
  }
}

const paramsType = (names, required) =>
  names.length ? `{ ${names.map((n) => `${key(n)}${required(n) ? "" : "?"}: string;`).join(" ")} }` : "never";

const out = [];
out.push(`// Сгенерировано scripts/gen-pao.mjs из ${SPEC} — не править вручную (К5).`);
out.push(`// ${spec.info.title} ${spec.info.version}, sha-256 ${sha}`);
out.push("");
out.push(`export const PAO_VERSION = ${JSON.stringify(spec.info.version)};`);
out.push(`export const PAO_SPEC_SHA256 = ${JSON.stringify(sha)};`);
out.push("");
for (const [name, s] of Object.entries(spec.components.schemas)) out.push(schemaDecl(name, s), "");

out.push("/** Операции ПАО: ключ — «МЕТОД путь» как в спецификации. */");
out.push("export interface PaoOperations {");
for (const o of ops) {
  out.push(`  /** ${o.summary} */`);
  out.push(`  ${JSON.stringify(o.key)}: {`);
  out.push(`    path: ${paramsType(o.pathParams, () => true)};`);
  out.push(`    query: ${paramsType(o.query.map((q) => q.name), (n) => o.query.find((q) => q.name === n).required)};`);
  out.push(`    body: ${o.body ? tsType(o.body, "    ") : "never"};`);
  out.push(`    response: ${o.response ? tsType(o.response, "    ") : "unknown"};`);
  out.push("  };");
}
out.push("}");
out.push("export type PaoOperationKey = keyof PaoOperations;");
out.push("");
out.push("export interface PaoOperationSpec {");
out.push("  method: string; path: string; signed: boolean; idempotent: boolean; success: number; errors: readonly number[];");
out.push("  pathParams: readonly string[]; query: readonly { name: string; required: boolean }[]; body?: unknown; response?: unknown;");
out.push("}");
out.push("");
const runtimeOps = Object.fromEntries(ops.map(({ key: k, summary, ...rest }) => [k, rest]));
out.push(`export const PAO_OPERATIONS: Record<PaoOperationKey, PaoOperationSpec> = ${JSON.stringify(runtimeOps, null, 2)};`);
out.push("");
out.push("/** Схемы components.schemas как в спецификации — для проверки тел в сервере-заглушке. */");
out.push(`export const PAO_SCHEMAS: Record<string, unknown> = ${JSON.stringify(spec.components.schemas, null, 2)};`);
out.push("");
const text = out.join("\n");

if (process.argv.includes("--check")) {
  const problems = [];
  if (!readFileSync(SOURCE, "utf8").includes(sha)) problems.push(`${SOURCE}: нет хэша ${sha}`);
  let current = "";
  try { current = readFileSync(OUT, "utf8"); } catch { /* нет файла */ }
  if (current !== text) problems.push(`${OUT} устарел: npm run gen:pao`);
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log(`${OUT} соответствует ${SPEC} (${sha.slice(0, 12)})`);
} else {
  writeFileSync(OUT, text);
  console.log(`${OUT}: ${Object.keys(spec.components.schemas).length} схем, ${ops.length} операций`);
}
