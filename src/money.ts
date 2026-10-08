/** Деньги — только целые копейки. Распределение суммы по долям без потери копейки (остаток — последнему). */
export function assertKop(n: number): void { if (!Number.isInteger(n) || n < 0) throw new Error("BAD_AMOUNT"); }

export function splitByWeights(total: number, weights: number[]): number[] {
  assertKop(total);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error("BAD_WEIGHTS");
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  const diff = total - parts.reduce((a, b) => a + b, 0);
  parts[parts.length - 1]! += diff;
  return parts;
}
