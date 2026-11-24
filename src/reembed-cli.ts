import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { reembed } from "./reembed.js";
import { MODEL_NAME, vectorChannelState } from "./embeddings.js";
import { errorBold, success, info, warn } from "./cli-utils.js";
import { resolveDbPathOrExit } from "./db-path.js";

/**
 * `megamemory reembed [--batch N]`
 *
 * Recomputes every node embedding with the current model (default
 * multilingual-e5-small, override with MEGAMEMORY_EMBED_MODEL). Long on CPU
 * — that is why it is a separate command. Resumable: interrupted runs
 * continue from meta.reembed_cursor. Before the first valid row is published,
 * search works without vectors (FTS/LIKE); after that, only rows already
 * published in the current generation are vector-searchable while FTS covers
 * the rest.
 */
export async function runReembed(args: string[]): Promise<void> {
  const batchFlag = args.indexOf("--batch");
  const batch = batchFlag !== -1 ? parseInt(args[batchFlag + 1], 10) : 16;
  if (isNaN(batch) || batch < 1) {
    errorBold("Invalid --batch value. Must be a positive integer.");
    process.exit(1);
  }

  const p = resolveDbPathOrExit(args);

  const db = new KnowledgeDB(p);
  try {
    const channel = vectorChannelState(db);
    if (channel.state === "on") {
      info(`embeddings already match ${MODEL_NAME} — checking for missing vectors`);
    } else if (channel.state === "partial") {
      info(`vector generation for ${MODEL_NAME} is incomplete: ${channel.missing}/${channel.total} node(s) have no vectors — continuing reembed`);
      info("vector search covers indexed nodes only; remaining nodes require keyword matches (every query word must occur)");
    } else if (channel.reason === "no_generation") {
      info("no vector generation yet — this run creates it (first run downloads the model once)");
      info("vector search starts after the first valid row is published; until then search requires keyword matches (every query word must occur)");
    } else if (channel.reason === "generation_without_vectors") {
      info(`vector generation for ${MODEL_NAME} has no published vectors yet — reembedding eligible nodes`);
      info("vector search starts after the first valid row is published; until then search requires keyword matches (every query word must occur)");
    } else if (channel.reason === "text_only_mode") {
      info("text-only search mode is enabled; reembed computes vectors, but semantic search remains disabled while MEGAMEMORY_SEARCH=fts");
    } else {
      const current = db.getMetaValue("embed_model") ?? db.getVectorGeneration()?.model ?? "(none recorded)";
      if (current !== MODEL_NAME) warn(`model changed: ${current} -> ${MODEL_NAME}`);
      else warn(`vector generation profile does not match ${MODEL_NAME} — rebuilding it`);
      info("vector search starts after the first valid row is published; remaining nodes require keyword matches (every query word must occur)");
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
