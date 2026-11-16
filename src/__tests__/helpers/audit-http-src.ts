import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AuditHarnessError, type AuditFixture } from "./audit.js";
import { startAuditHttpProcess, type AuditHttpResponse, type AuditSseEvent } from "./audit-http.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const tsxLoader = path.join(repository, "node_modules", "tsx", "dist", "loader.mjs");

export type AuditSrcHttpResponse = AuditHttpResponse;
export type AuditSrcSseEvent = AuditSseEvent;

/** Source adapter keeps setupFile injection; compiled tests still launch dist/index.js. */
export async function startAuditHttpSrc(fixture: AuditFixture, dbFile: string, options: { setupFile?: string } = {}) {
  if (!fs.existsSync(tsxLoader)) throw new AuditHarnessError("tsx is required to serve src/web.ts in audit tests");
  const relative = path.relative(fixture.root, path.resolve(fixture.root, dbFile));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AuditHarnessError("dbFile must remain inside the owned audit fixture");
  }
  // tsx CLI wraps another process on Windows; its loader runs in our directly owned Node child.
  const entry = fixture.file("serve-source.mts");
  const setupImport = options.setupFile ? `import ${JSON.stringify(pathToFileURL(options.setupFile).href)};\n` : "";
  fs.writeFileSync(entry,
    setupImport +
    `import { runServe } from ${JSON.stringify(pathToFileURL(path.join(repository, "src", "web.ts")).href)};\n` +
    `await runServe(0, "127.0.0.1");\n`, "utf8");
  return startAuditHttpProcess(fixture, dbFile, {
    args: ["--import", pathToFileURL(tsxLoader).href, entry],
    port: 0, env: { MEGAMEMORY_DB_PATH: dbFile },
  });
}

export type AuditHttpSrc = Awaited<ReturnType<typeof startAuditHttpSrc>>;
