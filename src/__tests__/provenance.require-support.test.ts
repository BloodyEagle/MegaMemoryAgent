import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { createConcept } from "../tools.js";
import { REQUIRE_SUPPORT_MESSAGE } from "../provenance.js";

vi.mock("../embeddings.js", () => ({
  embed: vi.fn(async () => {
    const embedding = new Float32Array([1, 0, 0]);
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }),
  embeddingText: vi.fn((name: string, kind: string, summary: string) =>
    `${kind}: ${name} — ${summary}`
  ),
  findTopK: vi.fn(() => []),
  embedForStorage: vi.fn(async () => {
    const embedding = new Float32Array([1, 0, 0]);
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }),
  vectorSearchEnabled: vi.fn(() => true),
}));

let db: KnowledgeDB;
let tmpDir: string;
const ENV_VARS = [
  "MEGAMEMORY_PROVENANCE_REQUIRE_SUPPORT",
  "MEGAMEMORY_REQUIRE_SUPPORT",
  "MEGAMEMORY_PROVENANCE_AUTO_GROUND",
] as const;
const savedEnv = ENV_VARS.map((name) => [name, process.env[name]] as const);

function setRequireSupport(value: boolean): void {
  fs.writeFileSync(
    path.join(tmpDir, "megamemory.config.json"),
    JSON.stringify({ provenance: { require_support: value } })
  );
}

beforeEach(() => {
  for (const [name] of savedEnv) delete process.env[name];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-require-support-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
});

// Close only: see provenance.trace.test.ts — the 4 s removal budget of
// helpers/cleanup.ts loses to libsql's post-close file lock on Windows.
afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  db.close();
});

describe("provenance.require_support strict mode (plan 3 step 8)", () => {
  it("8.4.1: flag off (default) — an unsupported decision is created", async () => {
    const result = await createConcept(db, {
      name: "Free Decision",
      kind: "decision",
      summary: "no support passed at all plus the fixture context of this check and the call keeps its contract",
    });

    expect(db.getNode(result.id).kind).toBe("decision");
  });

  it("8.4.2: flag on — refusal with the exact message, nothing written", async () => {
    setRequireSupport(true);

    await expect(
      createConcept(db, {
        name: "Unsupported Decision",
        kind: "decision",
        summary: "no support passed at all plus the fixture context of this check and the call keeps its contract",
      })
    ).rejects.toThrow(REQUIRE_SUPPORT_MESSAGE);

    expect(db.nodeExists("unsupported-decision")).toBe(false);
  });

  it("8.4.3: flag on — a decision with evidence is created", async () => {
    setRequireSupport(true);
    db.insertNode({ id: "support-node", name: "Support", kind: "config", summary: "s" });

    const result = await createConcept(db, {
      name: "Grounded Decision",
      kind: "decision",
      summary: "supported by evidence plus the fixture context of this check and the call keeps its contract",
      evidence: [{ node: "support-node", why: "measured in support-node" }],
    });

    expect(db.getNode(result.id).kind).toBe("decision");
    const edges = db.execSqlAll(
      "SELECT to_id FROM edges WHERE from_id = ? AND relation = 'informed_by' AND removed_at IS NULL",
      [result.id]
    );
    expect(edges).toHaveLength(1);
  });

  it("8.4.4: flag on — a feature without supports is still created (only decisions are gated)", async () => {
    setRequireSupport(true);

    const result = await createConcept(db, {
      name: "Plain Feature",
      kind: "feature",
      summary: "no support and that is fine plus the fixture context of this check and the call keeps its contract",
    });

    expect(db.getNode(result.id).kind).toBe("feature");
  });

  it("8.4.5: flag flip without a restart — two consecutive calls behave differently", async () => {
    setRequireSupport(true);
    await expect(
      createConcept(db, { name: "First Try", kind: "decision", summary: "s plus the fixture context of this check and the call keeps its contract with the evidence passed in the call" })
    ).rejects.toThrow(REQUIRE_SUPPORT_MESSAGE);

    setRequireSupport(false);
    const ok = await createConcept(db, { name: "Second Try", kind: "decision", summary: "s plus the fixture context of this check and the call keeps its contract with the evidence passed in the call" });
    expect(db.getNode(ok.id).kind).toBe("decision");
  });

  it("8.4.5b: env alias MEGAMEMORY_REQUIRE_SUPPORT overrides without a restart", async () => {
    process.env.MEGAMEMORY_REQUIRE_SUPPORT = "1";
    await expect(
      createConcept(db, { name: "Env Gated", kind: "decision", summary: "s plus the fixture context of this check and the call keeps its contract with the evidence passed in the call" })
    ).rejects.toThrow(REQUIRE_SUPPORT_MESSAGE);

    process.env.MEGAMEMORY_REQUIRE_SUPPORT = "0";
    const ok = await createConcept(db, { name: "Env Allowed", kind: "decision", summary: "s plus the fixture context of this check and the call keeps its contract with the evidence passed in the call" });
    expect(db.getNode(ok.id).kind).toBe("decision");
  });

  it("a direct informed_by edge counts as support (step 8.2 wording)", async () => {
    setRequireSupport(true);
    db.insertNode({ id: "source-node", name: "Source", kind: "config", summary: "s" });

    const result = await createConcept(db, {
      name: "Edge Decision",
      kind: "decision",
      summary: "supported by a plain informed_by edge plus the fixture context of this check and the call keeps its contract",
      edges: [{ to: "source-node", relation: "informed_by", description: "read from source-node" }],
    });

    expect(db.getNode(result.id).kind).toBe("decision");
  });

  it("auto_ground counts as support when it actually derives edges", async () => {
    setRequireSupport(true);
    process.env.MEGAMEMORY_PROVENANCE_AUTO_GROUND = "1";
    db.insertNode({
      id: "file-fact-existing",
      name: "src/impl.ts",
      kind: "feature",
      summary: "fact",
      file_refs: ["src/impl.ts"],
    });

    const result = await createConcept(db, {
      name: "Auto Decision",
      kind: "decision",
      summary: "auto-grounded plus the fixture context of this check and the call keeps its contract",
      why: "the file says so",
      file_refs: ["src/impl.ts"],
    });

    expect(db.getNode(result.id).kind).toBe("decision");
  });
});
