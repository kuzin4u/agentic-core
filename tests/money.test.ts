// money по К9: сумма — целые минимальные единицы и код валюты; операции в одной валюте.
import { describe, it, expect } from "vitest";
import { money, addMoney, splitMoney, assertMinor, isCurrencyCode, MoneyError, type Money } from "../src/index.js";

const MAX = Number.MAX_SAFE_INTEGER;
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as MoneyError).code; } return "ok"; };
const amounts = (ms: Money[]) => ms.map((m) => m.amount);

describe("money: код валюты", () => {
  it("ISO 4217 и коды активов проходят, остальное — нет", () => {
    for (const c of ["RUB", "JPY", "KWD", "XAU", "USDC", "EURC", "A12345678901"]) expect(isCurrencyCode(c), c).toBe(true);
    for (const c of ["rub", "RU", "1AB", "R-B", "RUB ", "A123456789012", "", 643]) expect(isCurrencyCode(c), String(c)).toBe(false);
    expect(code(() => money(1, "rub"))).toBe("BAD_CURRENCY");
  });
});

describe("money: сумма", () => {
  it("целое безопасное ≥ 0", () => {
    for (const n of [0, 1, MAX]) expect(code(() => assertMinor(n))).toBe("ok");
    for (const n of [-1, 1.5, NaN, Infinity, MAX + 1, "5"]) expect(code(() => assertMinor(n)), String(n)).toBe("BAD_AMOUNT");
  });

  it("addMoney: одна валюта; выше MAX_SAFE_INTEGER — BAD_AMOUNT", () => {
    expect(addMoney(money(150, "JPY"), money(50, "JPY"))).toEqual({ amount: 200, currency: "JPY" });
    expect(addMoney(money(MAX - 1, "USDC"), money(1, "USDC")).amount).toBe(MAX);
    expect(code(() => addMoney(money(MAX, "RUB"), money(1, "RUB")))).toBe("BAD_AMOUNT");
    expect(code(() => addMoney(money(1, "RUB"), money(1, "USD")))).toBe("CURRENCY_MISMATCH");
    expect(code(() => addMoney({ amount: 1.5, currency: "RUB" }, money(1, "RUB")))).toBe("BAD_AMOUNT");
  });
});

describe("money: splitMoney", () => {
  it("без потери единицы, остаток — последней доле с положительным весом", () => {
    expect(amounts(splitMoney(money(100001, "RUB"), [1, 1, 1]))).toEqual([33333, 33333, 33335]);
    expect(amounts(splitMoney(money(5, "RUB"), [1, 1, 0]))).toEqual([2, 3, 0]);
    expect(amounts(splitMoney(money(7, "KWD"), [0, 3, 0, 0]))).toEqual([0, 7, 0, 0]);
    expect(splitMoney(money(10, "USDC"), [5000, 5000]).every((m) => m.currency === "USDC")).toBe(true);
  });

  it("у MAX_SAFE_INTEGER — точно (BigInt)", () => {
    const M = BigInt(MAX);
    const parts = splitMoney(money(MAX, "USDC"), [2500, 7500]);
    expect(amounts(parts)).toEqual([Number(M / 4n), Number(M - M / 4n)]);
    expect(parts.reduce((a, m) => a + BigInt(m.amount), 0n)).toBe(M);
    // в Number произведение MAX × 2 округляется вверх, и первая доля вышла бы на единицу больше
    expect(amounts(splitMoney(money(MAX, "RUB"), [2, 1]))).toEqual([Number((M * 2n) / 3n), Number(M - (M * 2n) / 3n)]);
  });

  it("веса — неотрицательные целые, сумма > 0", () => {
    for (const w of [[], [0, 0], [1, -1], [0.5, 0.5], [NaN], [MAX + 1]]) expect(code(() => splitMoney(money(10, "RUB"), w)), String(w)).toBe("BAD_WEIGHTS");
    expect(code(() => splitMoney({ amount: -1, currency: "RUB" }, [1]))).toBe("BAD_AMOUNT");
  });
});
