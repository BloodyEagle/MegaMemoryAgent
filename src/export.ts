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
 */

export interface ExportDiff {
  written: number;
  missing: string[];
  differing: string[];
  extra: string[];
  /** М8: extra files removed by --check. */
  pruned?: number;
}

function nodeFileName(id: string): string {
  // id is unique and slug-safe (unicode-aware makeId + repair), but may
  // contain "/" — that becomes a subdirectory, Obsidian-friendly.
  const safe = id.split("/").map((part) => part.replace(/[<>:"|?*\\]/g, "_")).join("/");
  return `${safe || "node"}.md`;
}

function frontmatterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface MarkdownEdge {
  relation: string;
  to_id: string;
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
  const edgesLine =
    outgoing.length > 0
      ? `edges:${outgoing
          .map((e) => `\n  - relation: ${e.relation}\n    to: ${frontmatterValue(e.to_id)}`)
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
      .map((e) => ({ relation: e.relation, to_id: e.to_id }));
    files.set(
      nodeFileName(node.id),
      renderNodeMarkdown(node, outgoing, children)
    );
  }
  return files;
}

/** Write all files; creates subdirectories as needed. */
export function exportMarkdown(db: KnowledgeDB, dir: string): ExportDiff {
  const files = renderAllMarkdown(db);
  for (const [rel, content] of files) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return { written: files.size, missing: [], differing: [], extra: [] };
}

/**
 * Compare on-disk files with the current render (for CI --check mode).
 * Returns the diff; a non-empty diff means exit code 1.
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

  // Extra .md files on disk that the graph no longer produces — pruned
  // right away (М8): --check leaves the directory exactly in sync.
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        const rel = path.relative(dir, full).split(path.sep).join("/");
        if (!expected.has(rel)) {
          fs.unlinkSync(full);
          extra.push(rel);
        }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);

  return { written: 0, missing, differing, extra, pruned: extra.length };
}
