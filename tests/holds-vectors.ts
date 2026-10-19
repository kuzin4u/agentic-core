// Векторы holds против любой реализации AsyncHoldLedger: память и PostgreSQL проходят один и тот же сценарий.
// Неизвестный шаг — отказ прогона, а не пропуск (К20 п. 3): иначе новая операция «проходила» бы без реализации.
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import type { AsyncHoldLedger, HoldError } from "../src/index.js";

const V = JSON.parse(readFileSync("vectors/vectors.json", "utf8"));

/** Разделы векторов, которые знает прогон ядра; новый раздел без прогона — красный тест (core.test.ts). */
export const VECTOR_SECTIONS = ["version", "canonical", "journal", "journal_chain_genesis", "money", "holds", "holds_set_limit", "ed25519_weak_keys"];

type Step = { op: [string, ...any[]]; error?: string; available: unknown; account?: Record<string, number> };

export async function runSection(L: AsyncHoldLedger, steps: Step[], account: string): Promise<void> {
  const ids: Record<string, string> = {};
  for (const step of steps) {
    const [op, ...args] = step.op;
    const where = JSON.stringify(step.op);
    try {
      if (op === "open") await L.openAccount(args[0], args[1]);
      else if (op === "setLimit") await L.setLimit(args[0], args[1]);
      else if (op === "reserve") ids[args[2]] = (await L.reserve(args[0], args[1], args[2], args[3] ?? null)).id;
      else if (op === "commit") await L.commit(ids[args[0]]!, args[1], args[2] ?? false);
      else if (op === "release") await L.release(ids[args[0]]!);
      else if (op === "expire") await L.expire(args[0]);
      else throw new Error(`векторы holds: неизвестный шаг ${where}`);
      expect(step.error ?? null, where).toBeNull();
    } catch (e) {
      if (!(e as HoldError).code) throw e;
      expect((e as HoldError).code, where).toBe(step.error);
    }
    expect(await L.available(account), where).toEqual(step.available);
    if (step.account) expect(await L.account(account), where).toMatchObject(step.account);
  }
}

/** На PG — в отдельной схеме: шаг expire освобождает все истёкшие удержания таблицы. */
export async function runHoldVectors(L: AsyncHoldLedger): Promise<void> {
  await runSection(L, V.holds, "MND-1");
}

/** Раздел holds_set_limit (К20 п. 3): тот же прогон, плюс предел, закреплено, зарезервировано, version счёта. */
export async function runSetLimitVectors(L: AsyncHoldLedger): Promise<void> {
  await runSection(L, V.holds_set_limit, "LIM-1");
}
