// К10: isWeakEd25519 из основного входа и векторы ed25519_weak_keys (32 байта точки в hex).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as core from "../src/index.js";

const V = JSON.parse(readFileSync("vectors/vectors.json", "utf8"));
const spkiOf = (hex: string) => Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(hex, "hex")]).toString("base64");

describe("векторы ed25519_weak_keys (К10)", () => {
  it("isWeakEd25519 экспортирован из основного входа", () => {
    expect(typeof core.isWeakEd25519).toBe("function");
  });
  for (const v of V.ed25519_weak_keys as { point: string; weak: boolean; why: string }[]) {
    it(`${v.why}: ${v.point.slice(0, 16)}… — ${v.weak ? "слабый" : "обычный"}`, () => {
      expect(core.isWeakEd25519(Buffer.from(v.point, "hex"))).toBe(v.weak);
      // слабая точка в 32 байтах отвергается и ed25519Verifier — та же проверка при разборе ключа
      if (v.weak && v.point.length === 64) expect(core.ed25519Verifier.verify("ed25519", spkiOf(v.point), Buffer.from("m"), Buffer.alloc(64))).toBe(false);
    });
  }
});
