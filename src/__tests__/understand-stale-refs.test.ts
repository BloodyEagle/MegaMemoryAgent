import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { understand } from "../tools.js";
import { auditFixture, type AuditFixture } from "./helpers/audit.js";

type Output = Awaited<ReturnType<typeof understand>>;

let fixture: AuditFixture;
let db: KnowledgeDB;
let previousCwd: string;
let previousSearch: string | undefined;

beforeEach(() => {
  fixture = auditFixture();
  previousCwd = process.cwd();
  process.chdir(fixture.root);
  previousSearch = process.env.MEGAMEMORY_SEARCH;
  process.env.MEGAMEMORY_SEARCH = "fts";
  db = new KnowledgeDB(":memory:");
  ensureSchema(db);
});

afterEach(async () => {
  db.close();
  process.chdir(previousCwd);
  if (previousSearch === undefined) delete process.env.MEGAMEMORY_SEARCH;
  else process.env.MEGAMEMORY_SEARCH = previousSearch;
  await fixture.close();
});

function seedNode(id: string, refs: string[]): void {
  db.insertNode({
    id, name: id, kind: "feature",
    summary: `Verified fixture for ${id}: a concrete independent staleness example.`,
    ...(refs.length > 0 ? { file_refs: refs } : {}),
  });
}

function writeProjectFile(relative: string, content = "line1\nline2\n"): string {
  const abs = path.join(fixture.root, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

function touchToFuture(abs: string): void {
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(abs, future, future);
}

function touchToPast(abs: string): void {
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(abs, past, past);
}

async function query(id: string, extra: Partial<Parameters<typeof understand>[1]> = {}): Promise<Output> {
  return understand(db, { query: id, ...extra });
}

describe("understand stale_refs (план 26 §3)", () => {
  it("a file touched after the node write lands in stale_refs with the warning line", async () => {
    const abs = writeProjectFile("src/x.ts");
    seedNode("stale-hit", ["src/x.ts:1-2"]);
    touchToFuture(abs);
    const output = await query("stale-hit");
    expect(output.stale_refs).toHaveLength(1);
    expect(output.stale_refs![0]).toMatchObject({ ref: "src/x.ts:1-2", node_id: "stale-hit" });
    expect(output.stale_refs![0].recorded_at).toBeTruthy();
    expect(new Date(output.stale_refs![0].file_mtime).getTime()).toBeGreaterThan(
      new Date(output.stale_refs![0].recorded_at.replace(" ", "T") + "Z").getTime()
    );
    expect(output.next!.stale_warning).toBe("файл менялся после записи: перечитай ref, прежде чем опираться");
    expect(output.meta!.stale_refs_total).toBe(1);
    // Карточка с расхождением несёт updated_at — время записи узла.
    const card = output.compact![0] as { id: string; updated_at?: string };
    expect(card.updated_at).toBe(output.stale_refs![0].recorded_at);
  });

  it("an untouched file keeps the answer free of the stale section", async () => {
    const abs = writeProjectFile("src/fresh.ts");
    seedNode("stale-fresh", ["src/fresh.ts:1-2"]);
    touchToPast(abs);
    const output = await query("stale-fresh");
    expect(JSON.stringify(output)).not.toContain("stale_refs");
    expect(JSON.stringify(output)).not.toContain("updated_at");
    expect(output.next!.stale_warning).toBeUndefined();
  });

  it("a node without file_refs never produces the section", async () => {
    seedNode("stale-no-refs", []);
    const output = await query("stale-no-refs");
    expect(JSON.stringify(output)).not.toContain("stale_refs");
    expect(output.next!.stale_warning).toBeUndefined();
  });

  it("include_stale does not change the stale_refs behavior", async () => {
    const abs = writeProjectFile("src/x.ts");
    seedNode("stale-with-flag", ["src/x.ts:1-2"]);
    touchToFuture(abs);
    const output = await query("stale-with-flag", { include_stale: true });
    expect(output.stale_refs).toHaveLength(1);
    expect(output.meta!.stale_refs_total).toBe(1);
  });

  it("more than three divergences: three entries shown, the full count in meta", async () => {
    const refs: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      refs.push(`src/many-${i}.ts:1-2`);
      touchToFuture(writeProjectFile(`src/many-${i}.ts`));
    }
    seedNode("stale-many", refs);
    const output = await query("stale-many");
    expect(output.stale_refs).toHaveLength(3);
    expect(output.meta!.stale_refs_total).toBe(5);
    expect(output.next!.stale_warning).toBe("файл менялся после записи: перечитай ref, прежде чем опираться");
  });

  it("a missing file counts separately and never becomes a divergence", async () => {
    seedNode("stale-missing", ["src/absent-stale.ts:1-2"]);
    const output = await query("stale-missing");
    expect(output.stale_refs).toBeUndefined();
    expect(output.next!.stale_warning).toBeUndefined();
    expect(output.meta!.stale_refs_missing).toBe(1);
    expect(output.meta!.stale_refs_total).toBeUndefined();
  });

  it("a git ref without a filesystem axis is not checked by stat", async () => {
    seedNode("stale-git", ["HEAD:src/x.ts:1-2"]);
    const output = await query("stale-git");
    expect(output.stale_refs).toBeUndefined();
    expect(output.meta!.stale_refs_missing).toBeUndefined();
    expect(output.meta!.stale_refs_total).toBeUndefined();
  });
});
