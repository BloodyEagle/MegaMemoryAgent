import fs from "node:fs";
import path from "node:path";
import type { KnowledgeDB } from "./db.js";
import type { NodeRow } from "./types.js";

/**
 * Markdown export (plan T7): one file per node, git-diffable, Obsidian-open.
 *
 * - filename = node id (slashes become subdirectories), unique by PK;
 * - deterministic order (sorted by id) so repeated exports differ only when
 *   the graph changed;
 * - frontmatter: id, name, kind, status, parent, outgoing edges, updated_at;
 * - body: summary, why, children.
 *
 * S-02 (plan 05): ids are data, not paths. Segments are sanitized and the
 * final relative path is containment-checked; distinct ids that sanitize to
 * the same filename are a hard error, never a silent overwrite. --check
 * reports drift (including extra files) and deletes nothing (R-05).
 */

export interface ExportDiff {
  written: number;
  missing: string[];
  differing: string[];
  extra: string[];
}

/**
 * S-02 (plan 05): a stored id reaches the filesystem, and an imported db may
 * hold ids the slug rules would never produce ("../x", "a\\b", "C:\\x").
 * Render and write refuse to leave the export directory instead of trusting
 * the id.
 */
export class ExportPathError extends Error {}

// Windows silently strips trailing dots/spaces on lookup and keeps device
// names out of the user's reach — both would collide or misbehave on write.
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function sanitizeExportSegment(part: string): string {
  const safe = part.replace(/[<>:"|?*\\]/g, "_").replace(/[. ]+$/g, "");
  if (safe === "" || safe === "." || safe === "..") return "_";
  return WINDOWS_RESERVED.test(safe) ? `_${safe}` : safe;
}

function nodeFileName(id: string): string {
  // id is unique and slug-safe (unicode-aware makeId + repair), but may
  // contain "/" — that becomes a subdirectory, Obsidian-friendly. An
  // imported db bypassed makeId, so every segment is sanitized here (S-02).
  const safe = id.split("/").map(sanitizeExportSegment).join("/");
  const rel = `${safe || "node"}.md`;
  // Containment guard on the final relative path — defense in depth:
  // no absolute form, no remaining "." / ".." segments, no backslashes.
  if (
    path.posix.isAbsolute(rel) ||
    path.win32.isAbsolute(rel) ||
    rel.includes("\\") ||
    rel.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ExportPathError(
      `node id produces an unsafe export filename that could escape the target directory: ${JSON.stringify(id)}`
    );
  }
  return rel;
}

function frontmatterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface MarkdownEdge {
  relation: string;
  to_id: string;
  /** Plan 3 §5: informed_by edges export their rationale so the markdown
   * dump does not lose the support. */
  description?: string | null;
}

/**
 * U2: pure single-node render — one source of truth for the CLI export and
 * the explorer's download endpoints.
 */
export function renderNodeMarkdown(
  node: NodeRow,
  outgoing: MarkdownEdge[],
  children: NodeRow[]
): string {
  const parentLine = node.parent_id ? `parent: ${frontmatterValue(node.parent_id)}` : null;
  // Plan 3 §5/§9 (invariant 12): informed_by travels as its own frontmatter
  // block with the rationale — the export is a snapshot of CURRENT knowledge
  // (no tombstones), and losing the support would gut it.
  const informedBy = outgoing.filter((e) => e.relation === "informed_by");
  const otherEdges = outgoing.filter((e) => e.relation !== "informed_by");
  const edgesLine =
    otherEdges.length > 0
      ? `edges:${otherEdges
          .map((e) => `\n  - relation: ${e.relation}\n    to: ${frontmatterValue(e.to_id)}`)
          .join("")}`
      : null;
  const informedByLine =
    informedBy.length > 0
      ? `informed_by:${informedBy
          .map(
            (e) =>
              `\n  - to: ${frontmatterValue(e.to_id)}${
                e.description ? `\n    why: ${frontmatterValue(e.description)}` : ""
              }`
          )
          .join("")}`
      : null;

  const fm = [
    "---",
    `id: ${frontmatterValue(node.id)}`,
    `name: ${frontmatterValue(node.name)}`,
    `kind: ${node.kind}`,
    `status: ${node.status ?? "active"}`,
    ...(parentLine ? [parentLine] : []),
    ...(edgesLine ? [edgesLine] : []),
    ...(informedByLine ? [informedByLine] : []),
    `updated_at: ${frontmatterValue(node.updated_at)}`,
    "---",
    "",
    node.summary,
    "",
  ];

  if (node.why) {
    fm.push(`## Why`, "", node.why, "");
  }
  if (children.length > 0) {
    fm.push(`## Children`, "");
    for (const child of children) {
      const ref = nodeFileName(child.id).replace(/\.md$/, "");
      fm.push(`- [[${ref}|${child.name}]] — ${child.summary.replace(/\s+/g, " ").slice(0, 160)}`);
    }
    fm.push("");
  }

  return fm.join("\n");
}

/** Render the whole graph as { relativePath -> content }, sorted by id. */
export function renderAllMarkdown(db: KnowledgeDB): Map<string, string> {
  const files = new Map<string, string>();
  const rows = [...db.getAllNodesRaw()].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const node of rows) {
    if (node.removed_at !== null) continue;
    const children = db
      .getChildren(node.id)
      .filter((c) => c.kind !== "digest");
    const outgoing = db
      .getOutgoingEdges(node.id)
      .map((e) => ({
        relation: e.relation,
        to_id: e.to_id,
        description: e.description,
      }));
    const filename = nodeFileName(node.id);
    // S-02: distinct ids may sanitize to the same filename ("same?name" and
    // "same*name"). Silently overwriting the Map entry would lose a node —
    // fail loudly instead.
    if (files.has(filename)) {
      throw new ExportPathError(
        `export filename collision: two different node ids map to the same file "${filename}" ` +
          `(one of them is ${JSON.stringify(node.id)}); rename one of the nodes before exporting`
      );
    }
    files.set(
      filename,
      renderNodeMarkdown(node, outgoing, children)
    );
  }
  return files;
}

/**
 * Write all files; creates subdirectories as needed. Every resolved path is
 * checked against the target directory right before the write (S-02), and
 * the whole render — including collision and safety validation — happens
 * before the first byte hits the disk.
 */
export function exportMarkdown(db: KnowledgeDB, dir: string): ExportDiff {
  const files = renderAllMarkdown(db);
  const root = path.resolve(dir);
  for (const [rel, content] of files) {
    const full = path.resolve(root, rel);
    const contained = path.relative(root, full);
    if (contained === "" || contained.startsWith("..") || path.isAbsolute(contained)) {
      throw new ExportPathError(
        `export path escapes the target directory: ${JSON.stringify(rel)}`
      );
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return { written: files.size, missing: [], differing: [], extra: [] };
}

/**
 * Compare on-disk files with the current render (for CI --check mode).
 * Returns the diff; a non-empty diff means exit code 1.
 *
 * R-05 (plan 05): --check reports extra .md files but never deletes them —
 * the exporter has no ownership of the directory, and the old М8 prune
 * silently removed user-written notes (manual.md, nested notes) that only
 * happened to end with .md. Pruning is now a deliberate act: clean the
 * directory yourself once the diff says what is extra.
 */
export function checkMarkdown(db: KnowledgeDB, dir: string): ExportDiff {
  const expected = renderAllMarkdown(db);
  const missing: string[] = [];
  const differing: string[] = [];
  const extra: string[] = [];

  for (const [rel, content] of expected) {
    const full = path.join(dir, rel);
    if (!fs.existsSync(full)) {
      missing.push(rel);
      continue;
    }
    const onDisk = fs.readFileSync(full, "utf8");
    if (onDisk !== content) differing.push(rel);
  }

  // Extra .md files on disk that the graph no longer produces — reported,
  // not deleted (see the R-05 note above).
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        const rel = path.relative(dir, full).split(path.sep).join("/");
        if (!expected.has(rel)) extra.push(rel);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);

  return { written: 0, missing, differing, extra };
}
