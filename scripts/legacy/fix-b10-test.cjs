// Rewrite the Б10 test to the real MergeEngine API.
const fs = require("fs");
let s = fs.readFileSync("src/__tests__/conflicts.test.ts", "utf8").replace(/\r\n/g, "\n");

const start = s.indexOf('describe("conflict resolution lifecycle (Б10)"');
if (start === -1) { console.error("block not found"); process.exit(1); }

const clean = `describe("conflict resolution lifecycle (Б10)", () => {
  it("superseded status wins over active; valid_until kept", () => {
    const left = createTmpDb("left.db");
    const right = createTmpDb("right.db");
    const outputPath = path.join(tmpDir, "out.db");

    // Same node on both sides: left active, right superseded.
    left.db.insertNodeRaw({
      id: "auth", name: "Auth", kind: "decision", summary: "cookies",
      status: "active", valid_until: null,
    });
    left.db.clearNodeMergeFlags("auth");
    right.db.insertNodeRaw({
      id: "auth", name: "Auth", kind: "decision", summary: "jwt",
      status: "superseded", valid_until: "2030-01-01T00:00:00.000Z",
    });
    right.db.clearNodeMergeFlags("auth");
    left.db.close();
    right.db.close();

    const engine = new MergeEngine();
    engine.merge(left.path, right.path, outputPath, {
      leftLabel: "main",
      rightLabel: "feature",
    });

    const merged = new KnowledgeDB(outputPath);
    try {
      const conflictNodes = merged.getConflictNodes();
      expect(conflictNodes.length).toBeGreaterThan(0);
      const group = conflictNodes[0].merge_group!;

      const result = resolveConflict(merged, {
        merge_group: group,
        resolved: { summary: "jwt (resolved)" },
        reason: "test",
      });
      expect(result.message).toContain("Resolved");

      const final = merged.getAllNodesRaw().find(
        (n) => n.id === "auth" || n.id.startsWith("auth~")
      );
      expect(final).toBeDefined();
      expect(final!.status).toBe("superseded");
      expect(final!.valid_until).toBe("2030-01-01T00:00:00.000Z");
    } finally {
      merged.close();
    }
  });
});
`;

s = s.slice(0, start) + clean;
fs.writeFileSync("src/__tests__/conflicts.test.ts", s);
console.log("Б10 test rewritten");
