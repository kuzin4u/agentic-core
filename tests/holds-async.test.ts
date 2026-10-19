// AsyncHoldLedger в памяти (К6 п. 4): те же векторы, что у HoldLedger и PgHoldLedger.
import { describe, it, expect } from "vitest";
import { AsyncMemoryHoldLedger, HoldLedger } from "../src/index.js";
import { runHoldVectors, runSection, runSetLimitVectors } from "./holds-vectors.js";

describe("AsyncMemoryHoldLedger", () => {
  it("векторы holds", async () => {
    await runHoldVectors(new AsyncMemoryHoldLedger());
  });
  it("векторы holds_set_limit (К20 п. 3)", async () => {
    await runSetLimitVectors(new AsyncMemoryHoldLedger());
  });
  it("прогон векторов отказывает на неизвестном шаге (К20 п. 3)", async () => {
    const L = new AsyncMemoryHoldLedger();
    await L.openAccount("X", { amount: 1, currency: "RUB" });
    await expect(runSection(L, [{ op: ["raise", "X"], available: { amount: 1, currency: "RUB" } }], "X")).rejects.toThrow("неизвестный шаг");
  });
  it("обёртка над переданным HoldLedger: состояние общее", async () => {
    const L = new HoldLedger(); const A = new AsyncMemoryHoldLedger(L);
    await A.openAccount("A", { amount: 100, currency: "JPY" });
    L.reserve("A", { amount: 40, currency: "JPY" }, "r1");
    expect(await A.available("A")).toEqual({ amount: 60, currency: "JPY" });
  });
});
