import { describe, it, expect, afterEach } from "vitest";
import { auditFixture, sqlState, type AuditFixture } from "./helpers/audit.js";
import { KnowledgeDB } from "../db.js";
import { taskAdd, taskDone, board, computeBoard, taskRot, trailSave, trailRefresh, trailGet } from "../tools.js";

let fixture: AuditFixture | undefined;
let db: KnowledgeDB;

function freshDb(): KnowledgeDB {
  fixture = auditFixture();
  db = fixture.db("knowledge.db");
  return db;
}

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

/** Backdate a task so age-based rot is deterministic. */
function backdate(id: string, days: number): void {
  const expected = db.execSqlFirst("SELECT datetime('now', ?) AS at", `-${days} days`) as { at: string };
  db.execSqlRun(
    "UPDATE nodes SET created_at = ? WHERE id = ?",
    expected.at,
    id
  );
  expect(db.getNode(id)?.created_at).toBe(expected.at);
}

describe("task rot formula (plan 2 §3)", () => {
  it("rot = age + isolation(45) + overdue(400)", () => {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    expect(taskRot({ created_at: now, due_at: null, live_edges: 1 }).rot).toBe(0);
    const isolated = taskRot({ created_at: now, due_at: null, live_edges: 0 });
    expect(isolated.rot).toBe(45);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().replace("T", " ").slice(0, 19);
    const overdue = taskRot({ created_at: yesterday, due_at: "2020-01-01", live_edges: 1 });
    expect(overdue.overdue).toBe(true);
    expect(overdue.rot).toBe(1 + 400);
  });
});

describe("task board (plan 2 §3)", () => {
  it("backdating targets only the requested task and sets the exact timestamp", () => {
    freshDb();
    const target = taskAdd(db, "target task");
    const other = taskAdd(db, "untouched task");
    const untouched = db.getNode(other.id)!.created_at;
    backdate(target.id, 10);
    const expected = db.execSqlFirst("SELECT datetime('now', '-10 days') AS at") as { at: string };
    expect(db.getNode(target.id)!.created_at).toBe(expected.at);
    expect(db.getNode(other.id)!.created_at).toBe(untouched);
  });
  it("task_add creates a task node with task_state open; task_done closes it and clears due_at", async () => {
    freshDb();
    const added = taskAdd(db, "fix flaky test", "2020-01-01");
    const node = db.getNode(added.id)!;
    expect(node.kind).toBe("task");
    expect(node.task_state).toBe("open");
    expect(node.due_at).toBe("2020-01-01");

    taskDone(db, added.id);
    const closed = db.getNode(added.id)!;
    expect(closed.task_state).toBe("done");
    expect(closed.due_at).toBeNull();
    // done also clears it from the overdue counter.
    expect(computeBoard(db).overdue).toBe(0);
  });

  it("board sorts the open column by rot: overdue > isolated > age", async () => {
    freshDb();
    const a = taskAdd(db, "old task");          // old, connected
    db.insertNode({ id: "anchor", name: "Anchor", kind: "feature", summary: "s" });
    db.insertEdge({ from_id: a.id, to_id: "anchor", relation: "connects_to" });
    backdate(a.id, 10);

    const b = taskAdd(db, "isolated task");     // isolated, not overdue
    backdate(b.id, 5);

    const c = taskAdd(db, "overdue task", "2020-01-01"); // overdue wins
    backdate(c.id, 1);

    const out = computeBoard(db);
    const open = out.columns.find((col) => col.name === "open")!;
    expect(open.terminal).toBe(false);
    expect(open.cards.map((card) => card.id)).toEqual([c.id, b.id, a.id]);
    expect(out.overdue).toBe(1);
    expect(out.open).toBe(3);
  });

  it("done is a terminal column with fresh-first order", async () => {
    freshDb();
    const t1 = taskAdd(db, "first");
    taskDone(db, t1.id);
    const t2 = taskAdd(db, "second");
    taskDone(db, t2.id);
    const done = computeBoard(db).columns.find((col) => col.name === "done")!;
    expect(done.terminal).toBe(true);
    expect(done.cards[0].id).toBe(t2.id);
  });

  it("board() adds a human summary", async () => {
    freshDb();
    const out = board(db);
    expect(out.summary).toContain("0 open");
    taskAdd(db, "something", "2020-01-01");
    expect(board(db).summary).toContain("1 overdue");
  });

  it.each(["", "not-a-cursor", Buffer.from(JSON.stringify({ updated_at: 0, id: "task" })).toString("base64url"), Buffer.from(JSON.stringify({ updated_at: "2026-01-01", id: "" })).toString("base64url"), Buffer.from(JSON.stringify({ updated_at: "2026-01-01", id: "task" })).toString("base64url") + "!"])("D-03 malformed keyset cursor refuses without SQL changes: %s", done_cursor => {
    freshDb();
    const before = sqlState(db);
    expect(() => board(db, { done_cursor })).toThrow(/invalid done_cursor/);
    expect(sqlState(db)).toEqual(before);
  });

  it("D-04 broken refresh refuses with a reason and leaves the complete SQL snapshot unchanged", () => {
    freshDb();
    db.insertNode({ id: "member", name: "member", kind: "feature", summary: "Independent measured member" });
    const saved = trailSave(db, { node_ids: ["member"], summary: "Reasoning chain", name: "broken" });
    db.execSqlRun("DELETE FROM nodes WHERE id = 'member'");
    const before = sqlState(db);
    expect(() => trailRefresh(db, saved.id)).toThrow(/chain is broken, refresh impossible/);
    expect(sqlState(db)).toEqual(before);
    expect(trailGet(db, saved.id).state).toBe("broken");
  });

  it("task_add rejects duplicates and bad dates; task_done rejects unknown ids", async () => {
    freshDb();
    taskAdd(db, "write docs");
    expect(() => taskAdd(db, "write docs")).toThrow(/already exists/);
    expect(() => taskAdd(db, "x", "not-a-date")).toThrow(/parseable/);
    expect(() => taskDone(db, "ghost")).toThrow(/not found/);
  });
});
