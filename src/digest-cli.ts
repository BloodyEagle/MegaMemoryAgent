import pc from "picocolors";
import { KnowledgeDB } from "./db.js";
import { planDigests, rebuildDigests } from "./digest.js";
import { success, info, heading, skip } from "./cli-utils.js";
import { resolveDbPathOrExit } from "./db-path.js";
import { telemetryPathFromEnv } from "./telemetry.js";

/**
 * `megamemory digest [--module <id>] [--apply] [--by-use] [--limit N]`
 *
 * Rebuilds digest nodes: all parents with >=5 eligible children, or one parent.
 * Default is a dry-run report; --apply writes/updates digest nodes.
 *
 * P4.3 (план 20+21 v3 §13): --by-use упорядочивает ОЧЕРЕДЬ по явной
 * полезности (устаревание → явное использование → открытия; issued — только
 * там, где включена телеметрия J0, иначе n/a). Приоритет влияет на порядок и
 * ограниченную очередь (--limit), не исключает области: остаток едёт в
 * queued. Без достаточных событий — прежний порядок с пометкой недостатка
 * данных. Preview и apply используют ОДИН расчёт кандидатов.
 */
export async function runDigest(args: string[]): Promise<void> {
  const apply = args.includes("--apply");
  const byUse = args.includes("--by-use");
  const limitIdx = args.indexOf("--limit");
  const limitRaw = limitIdx !== -1 ? args[limitIdx + 1] : undefined;
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  if (limitIdx !== -1 && (!Number.isInteger(limit) || (limit as number) < 1)) {
    console.error(`digest: --limit expects a positive integer, got ${String(limitRaw)}`);
    process.exit(1);
  }
  const moduleIdx = args.indexOf("--module");
  const moduleId = moduleIdx !== -1 ? args[moduleIdx + 1] : undefined;

  const p = resolveDbPathOrExit(args);

  const db = new KnowledgeDB(p);
  try {
    const planOpts = {
      ...(byUse ? { by_use: true } : {}),
      ...(limit !== undefined ? { limit } : {}),
      // issued считается только там, где телеметрия J0 включена (env).
      ...(byUse ? { telemetry_path: telemetryPathFromEnv() } : {}),
    };
    if (!apply) {
      const { build, skipped, queued, use_note } = planDigests(db, moduleId, planOpts);
      heading(
        `  Digest plan: ${build.length} parent(s) to build, ${skipped.length} skipped` +
          (queued ? `, ${queued.length} queued` : "")
      );
      if (use_note) info(use_note);
      for (const b of build) {
        const use = b.use;
        const base = `(${b.children} children, ${b.created ? "new" : "refresh"})`;
        const useText = use
          ? `(children: ${b.children}, ${b.created ? "new" : "refresh"}` +
            `, opened: ${use.opened}${use.opened_error ? ` +err:${use.opened_error}` : ""}` +
            `, used: ${use.used}` +
            `, issued: ${use.issued === "unavailable" ? "n/a" : use.issued}` +
            `${use.stale_existing ? ", stale" : ""})`
          : base;
        console.log(`  ${pc.cyan(b.digestId)} ${pc.dim(useText)}`);
      }
      for (const q of queued ?? []) {
        console.log(`  ${pc.cyan(q.digestId)} ${pc.dim(`queued (${q.children} children)`)}`);
      }
      for (const s of skipped) {
        skip(`${s.moduleId}: ${s.children} children (need >=5)`);
      }
      info("dry run: nothing written. Pass --apply to build digests.");
      return;
    }

    const { built, skipped, queued, use_note } = await rebuildDigests(db, moduleId, planOpts);
    heading(
      `  Built ${built.length} digest(s), ${skipped.length} skipped${queued ? `, ${queued.length} queued` : ""}`
    );
    if (use_note) info(use_note);
    for (const b of built) {
      info(`${b.digestId} (${b.children} children, ${b.created ? "new" : "refresh"})`);
    }
    for (const q of queued ?? []) {
      info(`queued: ${q.digestId} (${q.children} children)`);
    }
    success(`built ${built.length} digest(s).`);
  } finally {
    db.close();
  }
}
