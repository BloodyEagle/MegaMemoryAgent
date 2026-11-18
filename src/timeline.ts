import type { KnowledgeDB } from "./db.js";
import type { TimelineActivity } from "./types.js";

const loggers = new WeakMap<KnowledgeDB, TimelineLogger>();

export interface TimelineLogger {
  log(entry: {
    tool: string;
    params: Record<string, unknown>;
    result_summary: string;
    is_write: boolean;
    is_error: boolean;
    affected_ids: string[];
  }): void;
  activity(): TimelineActivity;
}

/** Activity is scoped to the logger attached to this database, never its timeline rows. */
export function timelineActivity(db: KnowledgeDB): TimelineActivity | undefined {
  return loggers.get(db)?.activity();
}

export function createTimelineLogger(db: KnowledgeDB): TimelineLogger {
  const activity: TimelineActivity = { reads_since_write: 0, writes: 0, last_write_at: null };
  const logger: TimelineLogger = {
    activity() {
      return { ...activity };
    },
    log(entry) {
      if (entry.is_write) {
        activity.reads_since_write = 0;
        activity.writes += 1;
        activity.last_write_at = new Date().toISOString();
      } else {
        activity.reads_since_write += 1;
      }
      try {
        db.runWithRetry(
          () =>
            db.insertTimelineEntry({
              tool: entry.tool,
              params: JSON.stringify(entry.params),
              result_summary: entry.result_summary,
              is_write: entry.is_write,
              is_error: entry.is_error,
              affected_ids: entry.affected_ids,
            }),
          1
        );
      } catch (err) {
        // Timeline logging must never break tool execution
        console.error("Timeline logging failed:", err instanceof Error ? err.message : String(err));
      }
    },
  };
  loggers.set(db, logger);
  return logger;
}
