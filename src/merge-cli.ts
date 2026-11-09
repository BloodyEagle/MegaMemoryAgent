import fs from "fs";
import path from "path";
import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { MergeEngine, stripMergeSuffix, MERGE_SUFFIX_LEFT, MERGE_SUFFIX_RIGHT } from "./merge.js";
import { resolveConflict } from "./tools.js";
import { errorBold, success, info, error, openReadonlyOrExplain } from "./cli-utils.js";
import { resolveDbPathOrExit } from "./db-path.js";
import type { NodeRow } from "./types.js";
import { valueFlag } from "./cli-flags.js";

// ---- Flag parsing helpers ----

const getFlag = valueFlag;

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

// Boolean flags that don't consume a following value
const BOOLEAN_FLAGS = new Set(["--json"]);

function getPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith("--")) {
      if (BOOLEAN_FLAGS.has(args[i]) || args[i].includes("=")) {
        // Boolean flag — skip only the flag itself
        i += 1;
      } else {
        // Value flag — skip the flag and its value
        i += 2;
      }
    } else {
      positional.push(args[i]);
      i++;
    }
  }
  return positional;
}

// ---- merge command ----

export async function runMerge(args: string[]): Promise<void> {
  const positional = getPositionalArgs(args);

  if (positional.length < 2) {
    errorBold("Usage: megamemory merge <file1> <file2> [--into <output>] [--left-label <name>] [--right-label <name>]");
    process.exit(1);
  }

  const file1 = path.resolve(positional[0]);
  const file2 = path.resolve(positional[1]);
  const into = getFlag(args, "--into");
  const leftLabel = getFlag(args, "--left-label");
  const rightLabel = getFlag(args, "--right-label");

  // Default output: overwrite file1
  const outputPath = into ? path.resolve(into) : file1;

  if (!fs.existsSync(file1)) {
    errorBold(`File not found: ${file1}`);
    process.exit(1);
  }
  if (!fs.existsSync(file2)) {
    errorBold(`File not found: ${file2}`);
    process.exit(1);
  }

  // If overwriting file1, write to a temp file first then rename
  const isOverwrite = outputPath === file1;
  const actualOutput = isOverwrite
    ? `${outputPath}.merge-tmp-${Date.now()}`
    : outputPath;

  try {
    const engine = new MergeEngine();
    const result = engine.merge(file1, file2, actualOutput, { leftLabel, rightLabel });

    if (isOverwrite) {
      fs.renameSync(actualOutput, outputPath);
    }

    const totalConflicts = result.conceptConflicts + result.edgeConflicts;
    const conflictDetail = totalConflicts > 0
      ? ` (${result.conceptConflicts} concept${result.conceptConflicts !== 1 ? "s" : ""}, ${result.edgeConflicts} edge${result.edgeConflicts !== 1 ? "s" : ""})`
      : "";

    if (totalConflicts === 0) {
      success(
        `Merged: ${result.clean} clean, ${result.removedClean} removed, 0 conflicts`
      );
    } else {
      console.log(
        pc.yellow(`  ⚠ Merged: ${result.clean} clean, ${totalConflicts} conflicts${conflictDetail}`)
      );
      info(`Run ${pc.cyan("megamemory conflicts")} to view, or let your AI agent run ${pc.cyan("/merge")} to resolve.`);
    }

    // Plan 3 §2 (invariant 3): a cycle brought in by the union does not
    // abort the merge — the edges are flagged needs_merge and reported.
    if (result.informedByCycles && result.informedByCycles.length > 0) {
      console.log(
        pc.yellow(
          `  ⚠ informed_by cycle(s) after merge: ${result.informedByCycles.length} — edges flagged needs_merge`
        )
      );
      for (const component of result.informedByCycles) {
        console.log(`    ${pc.dim(component.join(" -> ") + " -> " + component[0])}`);
      }
      info(`New informed_by writes into these components are rejected until resolved.`);
    }
  } catch (err) {
    // Clean up temp file on error
    if (isOverwrite && fs.existsSync(actualOutput)) {
      fs.unlinkSync(actualOutput);
    }
    errorBold(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ---- conflicts command ----

export async function runConflicts(args: string[]): Promise<void> {
  const dbPath = resolveDbPathOrExit(args);
  const json = hasFlag(args, "--json");

  // План 18 (2.4.0): conflicts только читает узлы с needs_merge — база
  // открывается readonly. MEGAMEMORY_ALLOW_AUTO_MIGRATE=1 возвращает RW.
  const db = openReadonlyOrExplain(dbPath, "conflicts");
  try {
    const conflictNodes = db.getConflictNodes();

    if (conflictNodes.length === 0) {
      if (json) {
        console.log(JSON.stringify({ conflicts: [] }, null, 2));
      } else {
        success("No unresolved conflicts.");
      }
      return;
    }

    // Group by merge_group
    const groups = new Map<string, NodeRow[]>();
    for (const node of conflictNodes) {
      const mg = node.merge_group!;
      if (!groups.has(mg)) groups.set(mg, []);
      groups.get(mg)!.push(node);
    }

    if (json) {
      const output = {
        conflicts: Array.from(groups.entries()).map(([mergeGroup, nodes]) => ({
          merge_group: mergeGroup,
          merge_timestamp: nodes[0].merge_timestamp,
          versions: nodes.map((n) => ({
            id: n.id,
            original_id: stripMergeSuffix(n.id),
            source_branch: n.source_branch,
            name: n.name,
            kind: n.kind,
            summary: n.summary,
            why: n.why,
            file_refs: n.file_refs ? JSON.parse(n.file_refs) : null,
            removed_at: n.removed_at,
          })),
        })),
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    // Human-readable output
    console.log(
      pc.bold(`\n  ${groups.size} unresolved conflict${groups.size !== 1 ? "s" : ""}:\n`)
    );

    for (const [mergeGroup, nodes] of groups) {
      const shortGroup = mergeGroup.slice(0, 8);
      const originalId = stripMergeSuffix(nodes[0].id);
      console.log(pc.yellow(`  ── ${pc.bold(originalId)} ${pc.dim(`[${shortGroup}...]`)}`));

      for (const node of nodes) {
        const branch = node.source_branch ?? "unknown";
        const truncSummary = node.summary.length > 80
          ? node.summary.slice(0, 77) + "..."
          : node.summary;
        const isRemoved = node.removed_at !== null;

        console.log(
          `     ${pc.cyan(branch)}${isRemoved ? pc.red(" [removed]") : ""}: ${pc.dim(truncSummary)}`
        );

        if (node.file_refs) {
          const refs = JSON.parse(node.file_refs) as string[];
          if (refs.length > 0) {
            console.log(`     ${pc.dim("files: " + refs.slice(0, 3).join(", ") + (refs.length > 3 ? ` +${refs.length - 3} more` : ""))}`);
          }
        }
      }
      console.log();
    }

    info(`Resolve with: ${pc.cyan("megamemory resolve <merge_group> --keep <left|right|both>")}`);
    console.log();
  } finally {
    db.close();
  }
}

// ---- resolve command ----

export async function runResolve(args: string[]): Promise<void> {
  const positional = getPositionalArgs(args);

  if (positional.length < 1) {
    errorBold("Usage: megamemory resolve <merge_group> --keep <left|right|both>");
    process.exit(1);
  }

  const mergeGroup = positional[0];
  const keep = getFlag(args, "--keep") as "left" | "right" | "both" | undefined;

  if (!keep || !["left", "right", "both"].includes(keep)) {
    errorBold("--keep is required and must be one of: left, right, both");
    process.exit(1);
  }

  const dbPath = resolveDbPathOrExit(args);

  const db = new KnowledgeDB(dbPath);
  try {
    const nodes = db.getNodesByMergeGroup(mergeGroup);
    if (nodes.length === 0) {
      errorBold(`No nodes found with merge_group: ${mergeGroup}`);
      process.exit(1);
    }

    const leftNode = nodes.find((n) => n.id.endsWith(MERGE_SUFFIX_LEFT));
    const rightNode = nodes.find((n) => n.id.endsWith(MERGE_SUFFIX_RIGHT));

    if (!leftNode && !rightNode) {
      errorBold("Could not identify left/right versions in this merge group.");
      process.exit(1);
    }

    const originalId = stripMergeSuffix(nodes[0].id);

    if (keep === "both") {
      const remaps = [leftNode, rightNode].filter((node): node is NodeRow => node !== undefined)
        .map(node => ({ oldId: node.id, newId: `${originalId}-${node.source_branch ?? (node.id.endsWith(MERGE_SUFFIX_LEFT) ? "left" : "right")}` }));
      db.runInTransaction(() => {
        if (new Set(remaps.map(remap => remap.newId)).size !== remaps.length) {
          throw new Error("Both versions require distinct destination IDs.");
        }
        for (const remap of remaps) {
          if (db.getNodeIncludingRemoved(remap.newId)) throw new Error(`Node "${remap.newId}" already exists.`);
        }
        for (const remap of remaps) {
          if (!db.renameNodeId(remap.oldId, remap.newId)) throw new Error(`Failed to rename "${remap.oldId}".`);
          db.clearNodeMergeFlags(remap.newId);
        }
        db.clearEdgeMergeFlagsByGroup(mergeGroup);
      });
      success(`Kept both versions of "${originalId}" as separate concepts.`);
    } else {
      // keep left or right: та же доменная операция, что и MCP
      // resolve_conflict (F-03.1) — проигравший вариант не стирается вместе
      // со своими рёбрами и workflow-состоянием, а переезжает на выживший
      // identity с сохранением свидетельств.
      const winner = keep === "left" ? leftNode : rightNode;
      const loser = keep === "left" ? rightNode : leftNode;

      if (!winner) {
        errorBold(`No ${keep} version found in this merge group.`);
        process.exit(1);
      }

      const parseRefs = (raw: string | null): string[] | undefined => {
        if (!raw) return undefined;
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed.map(String) : undefined;
        } catch {
          return undefined;
        }
      };

      await resolveConflict(db, {
        merge_group: mergeGroup,
        resolved: {
          summary: winner.summary,
          ...(winner.why !== null && winner.why !== undefined ? { why: winner.why } : {}),
          ...(parseRefs(winner.file_refs) ?? {}),
        },
        reason: `keep ${keep}: CLI resolution keeping the ${winner.source_branch ?? keep} version`,
        prefer: keep,
      });

      const keptBranch = winner.source_branch ?? keep;
      success(`Resolved "${originalId}" — kept ${pc.cyan(keptBranch)} version.`);

      if (loser) {
        info(`Removed ${pc.dim(loser.source_branch ?? (keep === "left" ? "right" : "left"))} version; its edges and workflow state moved to the kept identity.`);
      }
    }
  } finally {
    db.close();
  }
}

// ---- helpers ----
