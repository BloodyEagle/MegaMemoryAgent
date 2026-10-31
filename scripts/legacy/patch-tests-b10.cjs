// Tests for Б10 (status merge rule), М7 (digest not consolidated), М8 (check prunes).
const fs = require("fs");
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const write = (f, s) => { fs.writeFileSync(f, s.replace(/\r\n/g, "\n")); console.log("patched", f); };

// conflicts.test.ts: resolveConflict applies the lifecycle rule
let ct = read("src/__tests__/conflicts.test.ts");
if (!ct.includes("Б10")) {
  const add = `
describe("conflict resolution lifecycle (Б10)", () => {
  it("superseded status wins over active; valid_until kept", async () => {
    const { db, leftPath, rightPath, outputPath } = setupConflictDb();
    try {
      // Two branches of the same node: left active, right superseded.
      const left = new KnowledgeDB(leftPath);
      left.insertNodeRaw({
        id: "auth", name: "Auth", kind: "decision", summary: "cookies",
        status: "active", valid_until: null,
      });
      left.clearNodeMergeFlags("auth");
      const right = new KnowledgeDB(rightPath);
      right.insertNodeRaw({
        id: "auth", name: "Auth", kind: "decision", summary: "jwt",
        status: "superseded", valid_until: "2030-01-01T00:00:00.000Z",
      });
      right.clearNodeMergeFlags("auth");
      left.close();
      right.close();

      const engine = new MergeEngine(leftPath, rightPath, outputPath, {
        leftLabel: "left", rightLabel: "right",
      });
      await engine.merge();

      const merged = new KnowledgeDB(outputPath);
      const conflictNodes = merged.getConflictNodes();
      expect(conflictNodes.length).toBeGreaterThan(0);
      const group = conflictNodes[0].merge_group!;

      const result = resolveConflict(merged, {
        merge_group: group,
        resolved: { summary: "jwt (resolved)" },
        reason: "test",
      });
      expect(result.message).toContain("Resolved");

      const node = merged.getNodeIncludingRemoved(
        merged.getConflictNodes()[0]?.id ?? "auth"
      );
      const final = merged.getAllNodesRaw().find((n) => n.id === "auth") ??
        merged.getAllNodesRaw().find((n) => n.id.startsWith("auth"));
      expect(final).toBeDefined();
      expect(final!.status).toBe("superseded");
      expect(final!.valid_until).toBe("2030-01-01T00:00:00.000Z");
      merged.close();
    } finally {
      fs.rmSync(path.dirname(leftPath), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
`;
  ct = ct.trimEnd() + "\n" + add;
  write("src/__tests__/conflicts.test.ts", ct);
}

// consolidate.test.ts: digest excluded (М7)
let co = read("src/__tests__/consolidate.test.ts");
if (!co.includes("М7")) {
  const add = `
describe("М7: digest excluded from consolidation", () => {
  it("digest nodes are never candidates even with identical vectors", () => {
    const db = freshDb();
    db.insertNode({ id: "m", name: "Module", kind: "module", summary: "m" });
    db.insertNode({ id: "m/d1", name: "Digest one", kind: "digest", summary: "digest payload", parent_id: "m" });
    db.insertNode({ id: "m/d2", name: "Digest two", kind: "digest", summary: "digest payload 2", parent_id: "m" });
    setEmbedding(db, "m/d1", [1, 0, 0, 0]);
    setEmbedding(db, "m/d2", [1, 0, 0, 0]);
    const candidates = findDuplicates(db, { threshold: 0.9 });
    expect(candidates).toHaveLength(0);
  });
});
`;
  co = co.trimEnd() + "\n" + add;
  write("src/__tests__/consolidate.test.ts", co);
}

// export.test.ts: --check prunes orphans (М8)
let ex = read("src/__tests__/export.test.ts");
if (!ex.includes("prunes")) {
  const add = `
  it("--check prunes orphan .md files (М8)", () => {
    const db = freshDb();
    db.insertNode({ id: "solo", name: "Solo", kind: "feature", summary: "one" });
    exportMarkdown(db, outDir);
    // Orphan on disk: graph no longer produces it.
    fs.writeFileSync(path.join(outDir, "orphan.md"), "stale", "utf8");
    const diff = checkMarkdown(db, outDir);
    expect(diff.extra).toEqual(["orphan.md"]);
    expect(diff.pruned).toBe(1);
    expect(fs.existsSync(path.join(outDir, "orphan.md"))).toBe(false);
  });
`;
  // insert inside the last describe before its closing
  const idx = ex.lastIndexOf("});");
  ex = ex.slice(0, idx) + add + ex.slice(idx);
  write("src/__tests__/export.test.ts", ex);
}
