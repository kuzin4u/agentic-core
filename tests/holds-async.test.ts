// AsyncHoldLedger в памяти (К6 п. 4): те же векторы, что у HoldLedger и PgHoldLedger.
import { describe, it, expect } from "vitest";
import { AsyncMemoryHoldLedger, HoldLedger } from "../src/index.js";
import { runHoldVectors } from "./holds-vectors.js";

describe("AsyncMemoryHoldLedger", () => {
  it("векторы holds", async () => {
    await runHoldVectors(new AsyncMemoryHoldLedger());
  });
  it("обёртка над переданным HoldLedger: состояние общее", async () => {
    const L = new HoldLedger(); const A = new AsyncMemoryHoldLedger(L);
    await A.openAccount("A", { amount: 100, currency: "JPY" });
    L.reserve("A", { amount: 40, currency: "JPY" }, "r1");
    expect(await A.available("A")).toEqual({ amount: 60, currency: "JPY" });
  });
});
