import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSchema } from "../migrate-schema.js";
import { updateConcept } from "../tools.js";
import { addNode, auditFixture, type AuditFixture } from "./helpers/audit.js";
import type { KnowledgeDB } from "../db.js";

// R-03 (plan 08): the embedding call is the real async window inside
// updateConcept — inference takes seconds and runs BEFORE the write
// transaction. A concurrent writer must not be able to smuggle a banned
// epistemic transition past the fresh-state re-validation (K-07 fix, here
// pinned as a race test).

const gate = vi.hoisted(() => ({
  open: null as (() => void) | null,
}));

const VEC = Buffer.alloc(384 * 4);

vi.mock("../embeddings.js", () => ({
  embed: () => Promise.resolve(VEC),
  embedForStorage: () =>
    new Promise<Buffer>((resolve) => {
      gate.open = () => resolve(VEC);
    }),
  embeddingText: (name: string, kind: string, summary: string) => `${kind}: ${name} — ${summary}`,
  findTopK: () => Promise.resolve([]),
  queryText: (t: string) => t,
  vectorSearchEnabled: () => true,
}));

let fixture: AuditFixture;
let db: KnowledgeDB;

beforeEach(() => {
  fixture = auditFixture();
  fixture.isolateHome();
  vi.stubEnv("MEGAMEMORY_PROVENANCE_REQUIRE_SUPPORT", "0");
  vi.stubEnv("MEGAMEMORY_REQUIRE_SUPPORT", "0");
  vi.stubEnv("MEGAMEMORY_PROVENANCE_AUTO_GROUND", "0");
  vi.stubEnv("MEGAMEMORY_AUTO_DIGEST", "0");
  db = fixture.db();
  ensureSchema(db);
  db.setMetaValue("embed_model", "audit-vector-space");
});

afterEach(async () => {
  try {
    await fixture.close();
  } finally {
    vi.unstubAllEnvs();
    gate.open = null;
  }
});

describe("R-03b: epistemic transition is re-validated against the fresh state", () => {
  it("a concurrent refuted write during the await window rejects the banned open->validated transition", async () => {
    addNode(db, "claim"); // open, epistemic_status null

    const pending = updateConcept(db, {
      id: "claim",
      changes: {
        summary: "Updated claim body that still asserts the measured behavior of the module.",
        epistemic_status: "validated",
        epistemic_reason: "Confirmed by the isolated rerun",
        status_scope: { artifact: "isolated-run-1" },
      },
    });

    // The await window is open — updateConcept is parked on inference.
    await vi.waitFor(() => {
      expect(gate.open).not.toBeNull();
    });

    // A concurrent tool call moves the node to refuted while update waits.
    db.setEpistemicStatus("claim", "refuted", "Disproved by the fresh run");
    gate.open!();

    await expect(pending).rejects.toThrow(/Invalid epistemic transition: refuted -> validated/);

    // Nothing was smuggled in: the status is still refuted, the history has
    // no validated row, and the summary write was rolled back with the rest.
    const node = db.getNode("claim")!;
    expect(node.epistemic_status).toBe("refuted");
    expect(node.summary).toBe(`Verified fixture for claim: a concrete independent audit example.`);
    const hist = db.getStatusHistory("claim", 50);
    expect(hist.filter((row) => row.to_status === "validated")).toEqual([]);
    expect(hist.some((row) => row.to_status === "refuted")).toBe(true);
  });
});
