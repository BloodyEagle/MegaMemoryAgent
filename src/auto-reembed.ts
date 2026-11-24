import path from "node:path";
import type { KnowledgeDB } from "./db.js";
import { MODEL_NAME, embed, vectorChannelState } from "./embeddings.js";
import { reembed, type ReembedOptions } from "./reembed.js";

const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const FAILURE_COOLDOWN_MAX_MS = 60 * 60 * 1000;
const FAILURE_PAUSE_LIMIT = 3;
const databasePaths = new WeakMap<KnowledgeDB, string>();
interface Attempt {
  completion: Promise<void>;
  running: boolean;
  succeeded: boolean;
  failedUntil: number;
  failures: number;
}
// Different connections to one file share an attempt; entries never retain a DB.
const attempts = new Map<string, Attempt>();

export interface AutoReembedOptions {
  embedFn?: ReembedOptions["embedFn"];
  /** Injectable background scheduler; defaults to an unreferenced immediate. */
  defer?: (run: () => void) => void;
  /** Injectable clock for the exponential cooldown after a failed attempt. */
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
  // A partial index only needs its gaps filled: beginVectorGeneration keeps
  // the active generation for the same model/profile, so reembed rebuilds
  // just the missing rows and never wipes published vectors.
  if (channel.state === "partial") return channel.missing > 0;
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
    // Failed attempts keep their strike count: deleting one would restart
    // the backoff ladder on a big index that keeps failing.
    if (!attempt.running && !attempt.succeeded && attempt.failures === 0 && attempt.failedUntil <= timestamp) attempts.delete(pathKey);
  }
  const previous = attempts.get(key);
  if (previous?.running) return previous.completion;
  if (previous?.succeeded || (previous && previous.failedUntil > timestamp)) return undefined;
  if (previous && previous.failures >= FAILURE_PAUSE_LIMIT) {
    console.error(
      `megamemory: automatic reembed paused after ${FAILURE_PAUSE_LIMIT} failures for ${db.dbPath} — run 'megamemory reembed' manually`,
    );
    return undefined;
  }

  let complete!: () => void;
  const completion = new Promise<void>((resolve) => { complete = resolve; });
  // A retry is the same logical attempt: it inherits the strike count, or the
  // backoff ladder would restart from ten minutes on every new attempt object.
  const attempt: Attempt = { completion, running: true, succeeded: false, failedUntil: 0, failures: previous?.failures ?? 0 };
  attempts.set(key, attempt);
  const fail = (error: unknown): void => {
    attempt.failures += 1;
    attempt.failedUntil = now() + Math.min(FAILURE_COOLDOWN_MS * 2 ** (attempt.failures - 1), FAILURE_COOLDOWN_MAX_MS);
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
      await reembed(db, {
        // Runs in reembed's own continuation, with no await before the generation switch.
        beforeGeneration: () => { if (!canStart(db)) throw superseded; },
        embedFn: async (text): Promise<Buffer> => {
          const buffer = await embedFn(text);
          if (!warmed) {
            warmed = true;
            // Do not replace a generation another caller published during warmup.
            if (!canStart(db)) throw superseded;
          }
          return buffer;
        },
      });
      // The attempt counts as successful only when the channel came out
      // complete; nodes registered while the run was publishing leave it
      // partial, and the next eligible trigger retries after the cooldown.
      // One successful attempt per process/base, even if metadata is later reset.
      if (vectorChannelState(db).state === "on") attempt.succeeded = true;
      else attempt.failedUntil = now() + FAILURE_COOLDOWN_MS;
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
