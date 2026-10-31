import fs from "node:fs";
import type { KnowledgeDB } from "../../db.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Close the database and remove the temp dir.
 *
 * libsql on Windows keeps the file locked for ~1.4 s after close() and only
 * releases it while the event loop is alive — a synchronous rmSync with
 * retries blocks the loop and never succeeds. So: close, then poll the
 * removal asynchronously. Cleanup failure never fails the test.
 */
export async function closeAndCleanup(
  db: KnowledgeDB,
  tmpDir: string
): Promise<void> {
  db.close();
  for (let i = 0; i < 40; i++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(100);
    }
  }
  console.warn(`cleanup: could not remove ${tmpDir}`);
}

/** Remove a temp dir that has no open db (same release caveat applies). */
export async function cleanupDir(tmpDir: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(100);
    }
  }
  console.warn(`cleanup: could not remove ${tmpDir}`);
}
