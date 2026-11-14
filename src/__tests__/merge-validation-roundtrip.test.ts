import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeDB } from "../db.js";
import { MergeEngine } from "../merge.js";
import { ensureSchema } from "../migrate-schema.js";
import { validationState } from "../validation.js";
import { isUngroundedRow } from "../provenance.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";

let fixture: AuditFixture;
beforeEach(() => { fixture = auditFixture(); });
afterEach(async () => { await fixture.close(); });

function database(name: string) {
  const db = fixture.db(name);
  ensureSchema(db);
  return db;
}

/** B-01: validated-узел с artifact-scope — структурно подтверждённая опора
 * (как в audit-S-03-S-04-S-05-merge: scope.artifact даёт anchored-квалификацию). */
function makeValidated(db: KnowledgeDB, id: string, summary: string, artifact: string): void {
  addNode(db, id, { kind: "component", summary });
  db.setEpistemicStatus(id, "validated", "Audit synthetic evidence", { artifact, context: "synthetic scope" });
}

/** Содержание журнала подтверждений без служебного node_id (он ремапится). */
function historyRows(db: KnowledgeDB, nodeId: string) {
  return db.execSqlAll(
    "SELECT from_status, to_status, reason, field, at, claim_digest, scope_digest, status_scope FROM status_history WHERE node_id = ? ORDER BY id",
    nodeId
  ) as Array<Record<string, unknown>>;
}

describe("B-01 merge keeps validation and the confirmation journal", () => {
  it.each(["stale", "unknown"] as const)("equal wording preserves current and %s versions on either side and repeated merge", (state) => {
    const current = database("current.db");
    const other = database("other.db");
    makeValidated(current, "verified", "Current wording", "audit-check.log");
    makeValidated(other, "verified", "Earlier wording", "audit-check.log");
    other.updateNode("verified", { summary: "Current wording" });
    if (state === "unknown") {
      other.execSqlRun("UPDATE nodes SET validation_claim_digest = NULL, validation_scope_digest = NULL WHERE id = ?", "verified");
    }
    const sources = [current.getNode("verified")!, other.getNode("verified")!];
    expect(sources.map(validationState)).toEqual(["current", state]);

    const versions = (db: KnowledgeDB) => db.getAllNodesRaw().map((row) => ({
      summary: row.summary,
      claim: row.validation_claim_digest ?? null,
      scope: row.validation_scope_digest ?? null,
      state: validationState(row),
      ungrounded: isUngroundedRow(row, false),
    })).sort((a, b) => a.state.localeCompare(b.state));
    const expected = [
      { summary: "Current wording", claim: sources[0].validation_claim_digest, scope: sources[0].validation_scope_digest, state: "current", ungrounded: false },
      { summary: "Current wording", claim: sources[1].validation_claim_digest, scope: sources[1].validation_scope_digest, state, ungrounded: true },
    ].sort((a, b) => a.state.localeCompare(b.state));
    const engine = new MergeEngine();
    for (const [label, left, right] of [["forward", current, other], ["reverse", other, current]] as const) {
      engine.merge(left.dbPath, right.dbPath, fixture.file(`${label}.db`));
      const output = fixture.db(`${label}.db`);
      expect(versions(output), "different validation must not collapse into the left keeper").toEqual(expected);
      expect(output.getAllNodesRaw().every((row) => row.needs_merge === 1)).toBe(true);
      engine.merge(output.dbPath, current.dbPath, fixture.file(`${label}-again.db`));
      const repeated = fixture.db(`${label}-again.db`);
      expect(versions(repeated)).toEqual(expected);
      expect(repeated.pragma("foreign_key_check")).toEqual([]);
    }
  });

  it("merge with an empty side keeps the validation digests and the full history", () => {
    const left = database("left.db");
    makeValidated(left, "verified", "Verified exact wording", "audit-check.log");
    const before = left.getNode("verified")!;
    expect(validationState(before)).toBe("current");
    expect(before.validation_claim_digest).toBeTruthy();
    expect(before.validation_scope_digest).toBeTruthy();
    const historyBefore = historyRows(left, "verified");
    expect(historyBefore).toHaveLength(1);
    expect(historyBefore[0].claim_digest).toBeTruthy();
    expect(historyBefore[0].scope_digest).toBeTruthy();
    expect(historyBefore[0].status_scope).toBeTruthy();

    const right = database("right.db");
    expect(right.getAllNodesRaw()).toHaveLength(0);
    new MergeEngine().merge(left.dbPath, right.dbPath, fixture.file("merged.db"));

    const output = fixture.db("merged.db");
    const after = output.getNode("verified")!;
    // Вербатим: merge переносит факт прошлой проверки, а не выдаёт новый.
    expect(after.validation_claim_digest).toBe(before.validation_claim_digest);
    expect(after.validation_scope_digest).toBe(before.validation_scope_digest);
    expect(after.epistemic_status).toBe("validated");
    expect(validationState(after)).toBe("current");
    expect(isUngroundedRow(after, false)).toBe(false);
    expect(historyRows(output, "verified")).toEqual(historyBefore);
    expect(output.pragma("foreign_key_check")).toEqual([]);
  });

  it("conflict round-trip keeps each side's validation with its copy", () => {
    const left = database("left.db");
    makeValidated(left, "verified", "Left wording", "left-audit.log");
    const right = database("right.db");
    makeValidated(right, "verified", "Right wording", "right-audit.log");
    const leftBefore = left.getNode("verified")!;
    const rightBefore = right.getNode("verified")!;
    const leftHistory = historyRows(left, "verified");
    const rightHistory = historyRows(right, "verified");

    new MergeEngine().merge(left.dbPath, right.dbPath, fixture.file("merged.db"));
    const output = fixture.db("merged.db");
    for (const [suffix, source, sourceHistory] of [
      ["::left", leftBefore, leftHistory],
      ["::right", rightBefore, rightHistory],
    ] as const) {
      const copy = output.getNode(`verified${suffix}`)!;
      expect(copy.summary).toBe(source.summary);
      expect(copy.validation_claim_digest).toBe(source.validation_claim_digest);
      expect(copy.validation_scope_digest).toBe(source.validation_scope_digest);
      expect(validationState(copy)).toBe("current");
      expect(isUngroundedRow(copy, false)).toBe(false);
      expect(historyRows(output, `verified${suffix}`)).toEqual(sourceHistory);
    }
    expect(output.pragma("foreign_key_check")).toEqual([]);
  });

  it("re-merging the output with an empty side loses nothing again", () => {
    const left = database("left.db");
    makeValidated(left, "verified", "Verified exact wording", "audit-check.log");
    new MergeEngine().merge(left.dbPath, fixture.db("right.db").dbPath, fixture.file("first.db"));
    const first = fixture.db("first.db");
    const afterFirst = first.getNode("verified")!;
    const historyAfterFirst = historyRows(first, "verified");
    expect(validationState(afterFirst)).toBe("current");
    expect(afterFirst.validation_claim_digest).toBeTruthy();

    new MergeEngine().merge(first.dbPath, fixture.db("right2.db").dbPath, fixture.file("second.db"));
    const second = fixture.db("second.db");
    const afterSecond = second.getNode("verified")!;
    expect(afterSecond.validation_claim_digest).toBe(afterFirst.validation_claim_digest);
    expect(afterSecond.validation_scope_digest).toBe(afterFirst.validation_scope_digest);
    expect(validationState(afterSecond)).toBe("current");
    expect(historyRows(second, "verified")).toEqual(historyAfterFirst);
    expect(historyRows(second, "verified")).toHaveLength(1);
  });

  it("left/right swap preserves the same fields", () => {
    const populated = database("populated.db");
    makeValidated(populated, "verified", "Verified exact wording", "audit-check.log");
    const before = populated.getNode("verified")!;
    const historyBefore = historyRows(populated, "verified");
    const empty = database("empty.db");

    new MergeEngine().merge(empty.dbPath, populated.dbPath, fixture.file("merged.db"));
    const output = fixture.db("merged.db");
    const after = output.getNode("verified")!;
    expect(after.validation_claim_digest).toBe(before.validation_claim_digest);
    expect(after.validation_scope_digest).toBe(before.validation_scope_digest);
    expect(validationState(after)).toBe("current");
    expect(isUngroundedRow(after, false)).toBe(false);
    expect(historyRows(output, "verified")).toEqual(historyBefore);
  });

  it("history entries with equal classic fields but different claim digests both survive", () => {
    const left = database("left.db");
    makeValidated(left, "verified", "Verified exact wording", "audit-check.log");
    // Две проверки одного перехода с одинаковыми старыми шестью полями,
    // но разным содержанием подтверждения — это НЕ дубликаты.
    const shared = ["verified", "validated", "validated", "re-check", "epistemic_status", "2026-11-10 00:00:00"];
    for (const [claim, scope, scopeJson] of [
      ["claim-a", "scope-a", '{"artifact":"a.log"}'],
      ["claim-b", "scope-b", '{"artifact":"b.log"}'],
    ] as const) {
      left.execSqlRun(
        "INSERT INTO status_history (node_id, from_status, to_status, reason, field, at, claim_digest, scope_digest, status_scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ...shared, claim, scope, scopeJson
      );
    }

    new MergeEngine().merge(left.dbPath, fixture.db("right.db").dbPath, fixture.file("merged.db"));
    const output = fixture.db("merged.db");
    const rows = historyRows(output, "verified");
    // Ровно по одной копии каждой проверки — обе дошли с содержанием.
    for (const [claim, scope, scopeJson] of [
      ["claim-a", "scope-a", '{"artifact":"a.log"}'],
      ["claim-b", "scope-b", '{"artifact":"b.log"}'],
    ] as const) {
      const copies = rows.filter((row) => row.claim_digest === claim);
      expect(copies).toHaveLength(1);
      expect(copies[0]).toMatchObject({
        from_status: "validated", to_status: "validated", reason: "re-check",
        field: "epistemic_status", at: "2026-11-10 00:00:00",
        scope_digest: scope, status_scope: scopeJson,
      });
    }
    expect(output.pragma("foreign_key_check")).toEqual([]);
  });

  it("a legacy source without claim columns carries nulls and invents nothing", () => {
    const legacy = database("legacy.db");
    addNode(legacy, "verified", { kind: "component", summary: "Old wording" });
    legacy.setEpistemicStatus("verified", "validated", "Old evidence", { artifact: "old.log" });
    // Эмуляция старого источника: таблица истории без колонок содержания
    // подтверждения (claim_digest/scope_digest/status_scope появились в 14).
    legacy.execSqlRun("DROP TABLE status_history");
    legacy.execSqlRun(`CREATE TABLE status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, from_status TEXT,
      to_status TEXT NOT NULL, reason TEXT, field TEXT NOT NULL DEFAULT 'status',
      at TEXT NOT NULL DEFAULT (datetime('now')))`);
    legacy.execSqlRun("CREATE INDEX idx_status_history_node ON status_history(node_id)");
    legacy.execSqlRun(
      "INSERT INTO status_history (node_id, from_status, to_status, reason, field, at) VALUES ('verified', 'active', 'validated', 'old transition', 'epistemic_status', '2026-11-01 00:00:00')"
    );

    new MergeEngine().merge(legacy.dbPath, fixture.db("right.db").dbPath, fixture.file("merged.db"));
    const output = fixture.db("merged.db");
    const rows = historyRows(output, "verified");
    expect(rows).toHaveLength(1);
    // Отсутствующее поле остаётся неизвестным — никакой достройки задним числом.
    expect(rows[0]).toEqual({
      from_status: "active", to_status: "validated", reason: "old transition",
      field: "epistemic_status", at: "2026-11-01 00:00:00",
      claim_digest: null, scope_digest: null, status_scope: null,
    });
  });

  it("repeated merge does not duplicate identical history entries", () => {
    const left = database("left.db");
    makeValidated(left, "verified", "Verified exact wording", "audit-check.log");
    new MergeEngine().merge(left.dbPath, fixture.db("right.db").dbPath, fixture.file("first.db"));
    const first = fixture.db("first.db");
    expect(historyRows(first, "verified")).toHaveLength(1);

    new MergeEngine().merge(first.dbPath, fixture.db("right2.db").dbPath, fixture.file("second.db"));
    const second = fixture.db("second.db");
    expect(historyRows(second, "verified")).toHaveLength(1);
  });
});
