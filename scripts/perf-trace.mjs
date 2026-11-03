#!/usr/bin/env node

/**
 * Manual benchmark for provenance_trace over large support stars
 * (plan-4-fixes-5). Runs by hand, never in CI, and holds no asserts — it
 * only prints numbers, so the smoke threshold in
 * src/__tests__/provenance.weaklinks-budget.test.ts can stay coarse while
 * real regressions are measured here.
 *
 * Usage: npm run build && node scripts/perf-trace.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeDB } from "../dist/db.js";
import { provenanceTrace } from "../dist/provenance.js";

const WIDTHS = [10_000, 20_000];
const RUNS = 3;
const SCAN_BUDGET = 100;

function buildStar(dbPath, width) {
  const db = new KnowledgeDB(dbPath);
  const rootId = `star${width}`;
  db.insertNode({
    id: rootId,
    name: "STAR",
    kind: "decision",
    summary: `decision ${rootId}`,
  });
  for (let i = 1; i <= width; i++) {
    db.insertNode({ id: `s${i}`, name: `S${i}`, kind: "config", summary: `s-${i}` });
  }
  for (let i = 1; i <= width; i++) {
    db.insertEdgeRaw({
      from_id: rootId,
      to_id: `s${i}`,
      relation: "informed_by",
      description: "why",
    });
  }
  return { db, rootId };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

for (const width of WIDTHS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-perf-trace-"));
  const { db, rootId } = buildStar(path.join(dir, "knowledge.db"), width);
  const runs = [];
  let weakLinksSize = 0;
  let edges = 0;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const out = provenanceTrace(db, { node_id: rootId, max_scan_nodes: SCAN_BUDGET });
    runs.push(performance.now() - t0);
    weakLinksSize = JSON.stringify(out.weak_links).length;
    edges = out.edges.length;
  }
  console.log(
    `star ${width}: runs=${runs.map((r) => r.toFixed(0)).join("/")} ms ` +
      `median=${median(runs).toFixed(0)} ms ` +
      `weak_links=${weakLinksSize} chars edges=${edges}`
  );
  db.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* libsql on Windows may hold the file briefly — the OS cleans tmp */
  }
}
