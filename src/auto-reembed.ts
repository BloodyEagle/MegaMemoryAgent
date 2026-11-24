import path from "node:path";
import type { KnowledgeDB } from "./db.js";
import { MODEL_NAME, embed, vectorChannelState } from "./embeddings.js";
import { reembed, type ReembedOptions } from "./reembed.js";

const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const databasePaths = new WeakMap<KnowledgeDB, string>();
interface Attempt {
  completion: Promise<void>;
  running: boolean;
  succeeded: boolean;
  failedUntil: number;
}
// Different connections to one file share an attempt; entries never retain a DB.
const attempts = new Map<string, Attempt>();

export interface AutoReembedOptions {
  embedFn?: ReembedOptions["embedFn"];
  /** Injectable background scheduler; defaults to an unreferenced immediate. */
  defer?: (run: () => void) => void;
  /** Injectable clock for the ten-minute cooldown after a failed attempt. */
  now?: () => number;
}

function normalizedDatabasePath(db: KnowledgeDB): string {
  const cached = databasePaths.get(db);
  if (cached) return cached;
  const resolved = path.resolve(db.dbPath);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  databasePaths.set(db, key);
  return key;
}

function canStart(db: KnowledgeDB): boolean {
  if (process.env.MEGAMEMORY_AUTO_REEMBED === "0") return false;
  const channel = vectorChannelState(db);
  return channel.state === "off" &&
    (channel.reason === "no_generation" || channel.reason === "generation_without_vectors") &&
    db.getReembedEligibleCount() > 0;
}

function reportFailure(db: KnowledgeDB, error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  console.error(`megamemory: automatic first-generation reembed failed: ${message}`);
  try {
    db.insertTimelineEntry({
      tool: "auto_reembed",
      params: JSON.stringify({ trigger: "first_generation", model: MODEL_NAME }),
      result_summary: message,
      is_write: true,
      is_error: true,
      affected_ids: [],
    });
  } catch {
    // Shutdown may close the connection while warmup/inference is awaiting.
  }
}

function deferBackground(run: () => void): void {
  setImmediate(run).unref();
}

/**
 * Schedule a missing first generation once per process/base, without delaying a response.
 * @param db - open knowledge base; connections to the same path are deduplicated
 * @param opts - optional embedder, scheduler and clock used by isolated tests
 * @returns completion with errors already reported, or undefined when skipped
 */
export function scheduleFirstGeneration(
  db: KnowledgeDB,
  opts: AutoReembedOptions = {},
): Promise<void> | undefined {
  // Opt-out must not read the database, schedule work or load the model.
  if (process.env.MEGAMEMORY_AUTO_REEMBED === "0") return undefined;
  let key: string;
  try {
    if (!canStart(db)) return undefined;
    key = normalizedDatabasePath(db);
  } catch (error) {
    reportFailure(db, error);
    return undefined;
  }
  const now = opts.now ?? Date.now;
  const timestamp = now();
  for (const [pathKey, attempt] of attempts) {
    if (!attempt.running && !attempt.succeeded && attempt.failedUntil <= timestamp) attempts.delete(pathKey);
  }
  const previous = attempts.get(key);
  if (previous?.running) return previous.completion;
  if (previous?.succeeded || (previous && previous.failedUntil > timestamp)) return undefined;

  let complete!: () => void;
  const completion = new Promise<void>((resolve) => { complete = resolve; });
  const attempt: Attempt = { completion, running: true, succeeded: false, failedUntil: 0 };
  attempts.set(key, attempt);
  const fail = (error: unknown): void => {
    attempt.failedUntil = now() + FAILURE_COOLDOWN_MS;
    reportFailure(db, error);
  };
  const finish = (): void => {
    attempt.running = false;
    if (attempt.failedUntil === 0 && !attempt.succeeded) attempts.delete(key);
    complete();
  };
  const superseded = new Error("Automatic reembed eligibility changed during warmup");
  const run = async (): Promise<void> => {
    try {
      // A queued call may outlive a node, the channel verdict or the opt-in.
      if (!canStart(db)) return;
      let warmed = false;
      const embedFn = opts.embedFn ?? embed;
      await reembed(db, { embedFn: async (text): Promise<Buffer> => {
        const buffer = await embedFn(text);
        if (!warmed) {
          warmed = true;
          // Do not replace a generation another caller published during warmup.
          if (!canStart(db)) throw superseded;
        }
        return buffer;
      } });
      // One successful attempt per process/base, even if metadata is later reset.
      attempt.succeeded = true;
    } catch (error) {
      if (error !== superseded) fail(error);
    } finally {
      finish();
    }
  };
  try {
    (opts.defer ?? deferBackground)(() => { void run(); });
  } catch (error) {
    fail(error);
    finish();
  }
  return completion;
}
