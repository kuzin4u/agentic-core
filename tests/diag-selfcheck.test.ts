import { describe, it, expect } from "vitest";
import { buildSelfCheckReport, checkSelfCheckReport, type DiagEntry, type DiagRegistry, type SelfCheckReport } from "../src/diag/index.js";
import { PAO_DIAG } from "../src/pao/index.js";

const entry = (code: string): DiagEntry => ({
  code, component: "platform", source: ["environment"], action: "after_fix",
  human: { ru: "Сервис временно недоступен." }, operator: { ru: "Проверьте настройку." }, norm: "К17 п. 8", since: "PS-ДГ",
});
const REG: DiagRegistry = { DB_MIGRATIONS_PENDING: entry("DB_MIGRATIONS_PENDING"), KEY_EXPIRES_SOON: entry("KEY_EXPIRES_SOON") };
const NOW = new Date("2026-10-19T08:00:00.000Z");

const report = (over: Record<string, unknown> = {}): SelfCheckReport => ({
  ...buildSelfCheckReport("platform", "1.2.0", [{ check: "db.migrations", status: "ok" }], NOW), ...over,
} as SelfCheckReport);

describe("К17 п. 8: отчёт самопроверки", () => {
  it("сборка: ready — нет fail; warn готовность не снимает; checked_at из now", () => {
    const warn = buildSelfCheckReport("agent", "0.9.0", [
      { check: "db.migrations", status: "ok" },
      { check: "keys.agent_expiry", status: "warn", code: "KEY_EXPIRES_SOON" },
    ], NOW);
    expect(warn).toEqual({
      component: "agent", version: "0.9.0", checked_at: "2026-10-19T08:00:00.000Z", ready: true,
      checks: [{ check: "db.migrations", status: "ok" }, { check: "keys.agent_expiry", status: "warn", code: "KEY_EXPIRES_SOON" }],
    });
    const fail = buildSelfCheckReport("agent", "0.9.0", [{ check: "db.migrations", status: "fail", code: "DB_MIGRATIONS_PENDING" }], NOW);
    expect(fail.ready).toBe(false);
    expect(checkSelfCheckReport(warn, REG)).toEqual([]);
    expect(checkSelfCheckReport(fail, REG)).toEqual([]);
  });

  it("объединённый реестр: код ядра в отчёте платформы, component записи не сверяется", () => {
    const r = buildSelfCheckReport("platform", "1.2.0", [{ check: "pao.spec_hash", status: "fail", code: "STATE_UNAVAILABLE" }], NOW);
    expect(checkSelfCheckReport(r, { ...REG, ...PAO_DIAG })).toEqual([]);
    expect(checkSelfCheckReport(r, REG)).toEqual([{ code: "SELFCHECK_CODE_UNKNOWN", check: "pao.spec_hash", field: "code" }]);
  });

  it("SELFCHECK_EMPTY: checks пуст или не массив", () => {
    expect(checkSelfCheckReport(report({ checks: [], ready: true }), REG)).toEqual([{ code: "SELFCHECK_EMPTY", field: "checks" }]);
    expect(checkSelfCheckReport(report({ checks: null }), REG)).toEqual([{ code: "SELFCHECK_EMPTY", field: "checks" }]);
  });

  it("SELFCHECK_FIELD: component, version, checked_at, ready, status", () => {
    expect(checkSelfCheckReport(report({ component: "bank", version: " ", checked_at: "2026-10-19T08:00:00+03:00", ready: "yes" }), REG)).toEqual([
      { code: "SELFCHECK_FIELD", field: "component" },
      { code: "SELFCHECK_FIELD", field: "version" },
      { code: "SELFCHECK_FIELD", field: "checked_at" },
      { code: "SELFCHECK_FIELD", field: "ready" },
    ]);
    expect(checkSelfCheckReport(report({ checks: [{ check: "db.migrations", status: "error" }] }), REG))
      .toEqual([{ code: "SELFCHECK_FIELD", check: "db.migrations", field: "status" }]);
    expect(checkSelfCheckReport(null as unknown as SelfCheckReport, REG)).toEqual([{ code: "SELFCHECK_FIELD" }]);
  });

  it("checked_at — только формат: без миллисекунд можно, Date.parse не NaN; календарь — v0.9.0", () => {
    expect(checkSelfCheckReport(report({ checked_at: "2026-10-19T08:00:00Z" }), REG)).toEqual([]);
    for (const at of ["2026-10-19 08:00:00Z", "2026-10-19T08:00:00.0Z", "2026-10-19", "2026-13-40T08:00:00Z", 0]) {
      expect([at, checkSelfCheckReport(report({ checked_at: at }), REG)]).toEqual([at, [{ code: "SELFCHECK_FIELD", field: "checked_at" }]]);
    }
    // 30 февраля Date.parse принимает (переносит на 2 марта): строгий разбор — не в этом выпуске.
    expect(checkSelfCheckReport(report({ checked_at: "2026-02-30T08:00:00Z" }), REG)).toEqual([]);
  });

  it("SELFCHECK_CHECK_FORMAT и SELFCHECK_DUPLICATE", () => {
    const r = report({ checks: [
      { check: "DB.migrations", status: "ok" }, { check: "1db", status: "ok" }, { status: "ok" },
      { check: "db.migrations", status: "ok" }, { check: "db.migrations", status: "ok" },
    ] });
    expect(checkSelfCheckReport(r, REG)).toEqual([
      { code: "SELFCHECK_CHECK_FORMAT", check: "DB.migrations", field: "check" },
      { code: "SELFCHECK_CHECK_FORMAT", check: "1db", field: "check" },
      { code: "SELFCHECK_CHECK_FORMAT", check: undefined, field: "check" },
      { code: "SELFCHECK_DUPLICATE", check: "db.migrations", field: "check" },
    ]);
  });

  it("SELFCHECK_CODE_MISSING, SELFCHECK_CODE_FORBIDDEN, SELFCHECK_CODE_UNKNOWN", () => {
    const r = buildSelfCheckReport("platform", "1.2.0", [
      { check: "a.warn", status: "warn" },
      { check: "b.fail", status: "fail", code: "" },
      { check: "c.ok", status: "ok", code: "KEY_EXPIRES_SOON" },
      { check: "d.fail", status: "fail", code: "NO_SUCH_CODE" },
      { check: "e.warn", status: "warn", code: "toString" },
    ], NOW);
    expect(checkSelfCheckReport(r, REG)).toEqual([
      { code: "SELFCHECK_CODE_MISSING", check: "a.warn", field: "code" },
      { code: "SELFCHECK_CODE_MISSING", check: "b.fail", field: "code" },
      { code: "SELFCHECK_CODE_FORBIDDEN", check: "c.ok", field: "code" },
      { code: "SELFCHECK_CODE_UNKNOWN", check: "d.fail", field: "code" },
      { code: "SELFCHECK_CODE_UNKNOWN", check: "e.warn", field: "code" },
    ]);
  });

  it("SELFCHECK_READY_MISMATCH: ready задан вручную вопреки fail и наоборот", () => {
    const fail = { check: "db.migrations", status: "fail", code: "DB_MIGRATIONS_PENDING" };
    expect(checkSelfCheckReport(report({ checks: [fail], ready: true }), REG)).toEqual([{ code: "SELFCHECK_READY_MISMATCH", field: "ready" }]);
    expect(checkSelfCheckReport(report({ ready: false }), REG)).toEqual([{ code: "SELFCHECK_READY_MISMATCH", field: "ready" }]);
  });
});
