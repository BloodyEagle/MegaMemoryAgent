import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { reembed } from "./reembed.js";
import { MODEL_NAME, vectorSearchEnabled } from "./embeddings.js";
import { errorBold, success, info, warn } from "./cli-utils.js";

function dbPath(): string {
  return (
    process.env.MEGAMEMORY_DB_PATH ??
    path.join(process.cwd(), ".megamemory", "knowledge.db")
  );
}

/**
 * `megamemory reembed [--batch N]`
 *
 * Recomputes every node embedding with the current model (default
 * multilingual-e5-small, override with MEGAMEMORY_EMBED_MODEL). Long on CPU
 * — that is why it is a separate command. Resumable: interrupted runs
 * continue from meta.reembed_cursor. Until it finishes, search works
 * without vectors (FTS/LIKE), so the graph stays usable.
 */
export async function runReembed(args: string[]): Promise<void> {
  const batchFlag = args.indexOf("--batch");
  const batch = batchFlag !== -1 ? parseInt(args[batchFlag + 1], 10) : 64;
  if (isNaN(batch) || batch < 1) {
    errorBold("Invalid --batch value. Must be a positive integer.");
    process.exit(1);
  }

  const p = dbPath();
  if (!fs.existsSync(p)) {
    errorBold(`No database at ${p}. Run inside a project with .megamemory/knowledge.db.`);
    process.exit(1);
  }

  const db = new KnowledgeDB(p);
  try {
    if (vectorSearchEnabled(db)) {
      info(`embeddings already match ${MODEL_NAME} — reindexing anyway`);
    } else {
      const current = db.getMetaValue("embed_model") ?? "(none recorded)";
      warn(`model changed: ${current} -> ${MODEL_NAME}`);
      info("vector search is disabled until reembed finishes");
    }

    const result = await reembed(db, {
      batch,
      onProgress: (done, total) => {
        process.stderr.write(
          `  reembed: ${done}/${total} nodes (${Math.round((done / Math.max(total, 1)) * 100)}%)\n`
        );
      },
    });

    success(
      `reembedded ${result.processed} node(s), dim=${result.dim}, model=${result.model}`
    );
  } finally {
    db.close();
  }
}
