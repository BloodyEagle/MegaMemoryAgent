import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { loadEvalPairs, runEval } from "./eval.js";
import { errorBold, success, info, heading, warn } from "./cli-utils.js";

function dbPath(): string {
  return (
    process.env.MEGAMEMORY_DB_PATH ??
    path.join(process.cwd(), ".megamemory", "knowledge.db")
  );
}

/**
 * `megamemory eval [--file <jsonl>] [--k 10] [--min 0.8]`
 *
 * Measures recall@k of the live search stack against an eval set
 * (fixtures/eval.jsonl by default). Exit 1 below --min — CI-friendly.
 */
export async function runEvalCli(args: string[]): Promise<void> {
  const fileIdx = args.indexOf("--file");
  const file =
    fileIdx !== -1 ? args[fileIdx + 1] : path.join("fixtures", "eval.jsonl");
  const kIdx = args.indexOf("--k");
  const k = kIdx !== -1 ? parseInt(args[kIdx + 1], 10) : 10;
  const minIdx = args.indexOf("--min");
  const min = minIdx !== -1 ? parseFloat(args[minIdx + 1]) : 0.8;

  if (!fs.existsSync(file)) {
    errorBold(`Eval set not found: ${file}`);
    process.exit(1);
  }
  const p = dbPath();
  if (!fs.existsSync(p)) {
    errorBold(`No database at ${p}.`);
    process.exit(1);
  }

  const pairs = loadEvalPairs(fs.readFileSync(file, "utf8"));
  if (pairs.length === 0) {
    errorBold("Eval set is empty.");
    process.exit(1);
  }

  const db = new KnowledgeDB(p);
  try {
    const result = await runEval(db, pairs, { k });

    heading(`  megamemory eval — ${pairs.length} pairs, recall@${k}`);
    const mark = result.recall >= min ? pc.green : pc.red;
    console.log(
      `  overall: ${mark(result.recall.toFixed(3))} (${result.hits}/${result.total})`
    );
    for (const [lang, bucket] of Object.entries(result.perLang)) {
      console.log(
        `    ${lang.padEnd(6)} ${bucket.recall.toFixed(3)} (${bucket.hits}/${bucket.total})`
      );
    }
    if (result.misses.length > 0) {
      for (const miss of result.misses.slice(0, 10)) {
        warn(`miss: "${miss.query}" -> ${miss.expected_id} (${miss.lang})`);
      }
    }

    if (result.recall < min) {
      errorBold(`recall ${result.recall.toFixed(3)} < min ${min}`);
      process.exit(1);
    }
    success(`recall@${k} ${result.recall.toFixed(3)} >= ${min}`);
    info("eval sets live in fixtures/eval.jsonl — extend them as the graph grows.");
  } finally {
    db.close();
  }
}
