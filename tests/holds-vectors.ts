// Векторы holds против любой реализации AsyncHoldLedger: память и PostgreSQL проходят один и тот же сценарий.
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import type { AsyncHoldLedger, HoldError } from "../src/index.js";

const V = JSON.parse(readFileSync("vectors/vectors.json", "utf8"));

/** На PG — в отдельной схеме: шаг expire освобождает все истёкшие удержания таблицы. */
export async function runHoldVectors(L: AsyncHoldLedger): Promise<void> {
  const ids: Record<string, string> = {};
  for (const step of V.holds) {
    const [op, ...args] = step.op;
    const where = JSON.stringify(step.op);
    try {
      if (op === "open") await L.openAccount(args[0], args[1]);
      if (op === "reserve") ids[args[2]] = (await L.reserve(args[0], args[1], args[2], args[3] ?? null)).id;
      if (op === "commit") await L.commit(ids[args[0]]!, args[1], args[2] ?? false);
      if (op === "release") await L.release(ids[args[0]]!);
      if (op === "expire") await L.expire(args[0]);
      expect(step.error ?? null, where).toBeNull();
    } catch (e) {
      expect((e as HoldError).code, where).toBe(step.error);
    }
    expect(await L.available("MND-1"), where).toEqual(step.available);
  }
}
