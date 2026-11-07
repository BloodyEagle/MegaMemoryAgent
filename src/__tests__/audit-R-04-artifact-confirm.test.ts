import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkArtifacts } from "../artifacts.js";
import { ensureSchema } from "../migrate-schema.js";
import { provenanceTrace } from "../provenance.js";
import { CheckBudget, computeSupportCheck, confirmSupports } from "../support-baselines.js";
import { getConcept, link, updateConcept } from "../tools.js";
import { addNode, auditFixture, sqlState, type AuditFixture } from "./helpers/audit.js";
import type { KnowledgeDB } from "../db.js";

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => { throw new Error("Audit tests must not load an inference model"); }),
}));

let fixture: AuditFixture;
beforeEach(() => {
  fixture = auditFixture();
  fixture.isolateHome();
});
afterEach(async () => { await fixture.close(); });

function freshDb() {
  const db = fixture.db();
  ensureSchema(db);
  db.setMetaValue("embed_model", "audit-disabled-vector-space");
  return db;
}

function supportCheck(db: KnowledgeDB, decision = "consumer") {
  return computeSupportCheck(db, decision, new CheckBudget(5000, 2_000_000));
}

/** Server-returned digests only: no client-side hashing anywhere. */
function readConfirmation(db: KnowledgeDB) {
  const trace = provenanceTrace(db, { node_id: "consumer" });
  return {
    decision_id: "consumer",
    expected_claim_digest: trace.current_digests!.claim,
    items: (trace.supports ?? []).map((support) => ({
      support_id: support.support_id,
      expected_claim_digest: support.claim_digest!,
      expected_status_digest: support.status_digest!,
      expected_edge_digest: support.edge_digest,
      expected_artifacts_digest: support.artifacts_digest,
    })),
  };
}

async function linkedArtifacts(db: KnowledgeDB, refs: string[]) {
  addNode(db, "source", { file_refs: refs });
  addNode(db, "consumer", { kind: "decision" });
  link(db, { from: "consumer", to: "source", relation: "informed_by", description: "The referenced independent measurement supports this decision." });
  await checkArtifacts(db, { node_ids: ["source"], cwd: fixture.root });
}

describe("R-04: the artifact version the agent read is the one it confirms", () => {
  it("a check between the read and the confirm refuses the pinned version and writes nothing", async () => {
    const db = freshDb();
    const file = fixture.file("one.txt");
    fs.writeFileSync(file, "The first independently observed artifact.", "utf8");
    await linkedArtifacts(db, [file]);

    // The agent reads the current observation state...
    const read = readConfirmation(db);
    expect(read.items[0].expected_artifacts_digest).toBeTruthy();

    // ...then someone else checks again, and the file has moved on.
    fs.writeFileSync(file, "The second independently observed artifact.", "utf8");
    await checkArtifacts(db, { node_ids: ["source"], cwd: fixture.root });
    const before = sqlState(db);

    expect(() => confirmSupports(db, read)).toThrow(/version_conflict/);
    expect(sqlState(db)).toEqual(before);
  });

  it("the read version is confirmable when nothing moved between the calls", async () => {
    const db = freshDb();
    const file = fixture.file("one.txt");
    fs.writeFileSync(file, "An unchanged independently observed artifact.", "utf8");
    await linkedArtifacts(db, [file]);

    const result = confirmSupports(db, readConfirmation(db));

    expect(result.confirmed).toBe(1);
    expect(supportCheck(db)?.state).toBe("unchanged");
  });

  it("confirms an unobserved support with expected_artifacts_digest: null", async () => {
    const db = freshDb();
    addNode(db, "source");
    addNode(db, "consumer", { kind: "decision" });
    link(db, { from: "consumer", to: "source", relation: "informed_by", description: "The independent measurement supports this decision." });

    const read = readConfirmation(db);
    expect(read.items[0].expected_artifacts_digest).toBeNull();

    const result = confirmSupports(db, read);
    expect(result.confirmed).toBe(1);
    expect(supportCheck(db)?.state).toBe("unchanged");
  });
});

describe("R-04: the resolution root of a raw ref is pinned on the observation", () => {
  it("later checks resolve a relative ref against the pinned root, not the ambient cwd", async () => {
    const db = freshDb();
    const file = fixture.file("evidence.txt");
    fs.writeFileSync(file, "The pinned independently observed content.", "utf8");
    addNode(db, "source", { file_refs: ["evidence.txt"] });
    await checkArtifacts(db, { node_ids: ["source"], cwd: fixture.root });
    const digestBefore = db.getNodeArtifacts("source")[0].digest;

    // A different directory holds a DIFFERENT file with the same name; the
    // ambient cwd of this process is not the fixture root.
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "mm-r04-decoy-"));
    try {
      fs.writeFileSync(path.join(decoy, "evidence.txt"), "Unrelated decoy content.", "utf8");

      const result = await checkArtifacts(db, { node_ids: ["source"] });

      // The pin won: the decoy file was never read, the observation did not move.
      expect(result).toEqual({ checked: 1, changed: [], missing: [], truncated: false });
      const row = db.getNodeArtifacts("source")[0];
      expect(row.repo_path).toBe(fixture.root);
      expect(row.digest).toBe(digestBefore);
    } finally {
      fs.rmSync(decoy, { recursive: true, force: true });
    }
  });

  it("an explicit cwd is the override: it re-pins and honestly reports the change", async () => {
    const db = freshDb();
    const file = fixture.file("evidence.txt");
    fs.writeFileSync(file, "The pinned independently observed content.", "utf8");
    addNode(db, "source", { file_refs: ["evidence.txt"] });
    await checkArtifacts(db, { node_ids: ["source"], cwd: fixture.root });

    const moved = fs.mkdtempSync(path.join(os.tmpdir(), "mm-r04-moved-"));
    try {
      fs.writeFileSync(path.join(moved, "evidence.txt"), "The relocated independent observation.", "utf8");
      const result = await checkArtifacts(db, { node_ids: ["source"], cwd: moved });

      expect(result.changed).toHaveLength(1);
      expect(result.changed[0]).toMatchObject({ node_id: "source", ref: "evidence.txt" });
      expect(db.getNodeArtifacts("source")[0].repo_path).toBe(moved);
    } finally {
      fs.rmSync(moved, { recursive: true, force: true });
    }
  });
});

describe("R-04: supports[] exposes the active artifact digest", () => {
  it("the trace carries the combined digest the confirm can pin", async () => {
    const db = freshDb();
    const file = fixture.file("one.txt");
    fs.writeFileSync(file, "Trace-visible independent content.", "utf8");
    await linkedArtifacts(db, [file]);

    const trace = provenanceTrace(db, { node_id: "consumer" });
    expect(trace.supports).toHaveLength(1);
    expect(trace.supports![0].artifacts_digest).toBeTruthy();

    // And it matches what confirm_supports will pin — confirming with it
    // succeeds and leaves the support unchanged.
    confirmSupports(db, readConfirmation(db));
    expect(supportCheck(db)?.state).toBe("unchanged");
  });
});
