import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { KnowledgeDB } from "./db.js";
import type {
  CheckArtifactsInput,
  CheckArtifactsOutput,
  MissingArtifact,
  NodeArtifactRow,
} from "./types.js";

/**
 * 2.1.3 F2: digests of the external artifacts a node references (files, git
 * blobs). The explicit check_artifacts is the ONLY writer — reads (including
 * the support check) never hash files: background hashing on every read is
 * both a privacy and a cost decision. kind = 'url' is deliberately out of
 * scope for this release: network access from the MCP server is a separate
 * decision (timeouts, proxies, privacy).
 *
 * The verdict for support_check is derived BY CONTENT, not by clocks: at
 * confirmation time the digest of the support's observed artifacts is saved
 * INTO the snapshot (support_baselines.artifacts_digest); a check compares
 * the current observation against that saved value. A first-ever check after
 * the confirmation signals nothing (nothing was saved), a file that changed
 * twice still signals (the comparison is against the confirmed value), and a
 * re-confirmation clears the signal.
 */

/** Bump when the payload shape changes; old values honestly stop matching. */
const ARTIFACTS_DIGEST_VERSION = "v1";

/** <rev>:<path> — git blob; a Windows drive path (C:\…) never matches:
 * the prefix before ':' must be HEAD or 6..40 hex chars. */
const GIT_REF_RE = /^(HEAD|[0-9a-fA-F]{6,40}):(.+)$/;

export type ArtifactKind = "file" | "git_blob";

export interface ClassifiedRef {
  kind: ArtifactKind;
  /** For git_blob: the part before ':' ("HEAD", a sha…). */
  rev?: string;
}

export function classifyRef(ref: string): ClassifiedRef {
  const m = ref.match(GIT_REF_RE);
  if (m) return { kind: "git_blob", rev: m[1] };
  return { kind: "file" };
}

/** sha256 over a stream; size counted on the way through. */
function hashStream(stream: NodeJS.ReadableStream): Promise<{ digest: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let size = 0;
    stream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      hash.update(buf);
      size += buf.length;
    });
    stream.on("end", () => resolve({ digest: hash.digest("hex"), size }));
    stream.on("error", reject);
  });
}

/** Stream the file; null when it does not exist (missing is not a crash). */
async function hashFile(absPath: string): Promise<{ digest: string; size: number } | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return hashStream(fs.createReadStream(absPath));
}

/** Run git, collect stdout (bounded by the blob size we are willing to read). */
function runGit(args: string[], cwd: string, maxBuffer: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("git timed out"));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBuffer) {
        child.kill();
        clearTimeout(timer);
        reject(new Error("git output exceeded the buffer"));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`git ${args[0]} exited with ${code}`));
    });
  });
}

/**
 * git_blob: `git rev-parse` verifies the rev (and that the directory is under
 * git at all), `git cat-file` streams the blob content. Any failure — not a
 * repo, bad rev, path not in the rev — reads as missing, never a crash.
 */
async function hashGitBlob(
  rev: string,
  ref: string,
  cwd: string
): Promise<{ digest: string; size: number } | null> {
  const MAX_BLOB = 64 * 1024 * 1024;
  try {
    await runGit(["rev-parse", "--verify", rev], cwd, 4096);
    const content = await runGit(["cat-file", "blob", ref], cwd, MAX_BLOB);
    const digest = createHash("sha256").update(content).digest("hex");
    return { digest, size: content.length };
  } catch {
    return null;
  }
}

/**
 * The combined artifacts digest of a node: sha256 over its observed artifact
 * rows sorted by (kind, ref). A missing row digest contributes the empty
 * string. NULL when the node has no observed artifacts — "nothing observed"
 * must stay distinguishable from "observed and matching" (a confirmation
 * before any check saves NULL and never signals).
 */
export function artifactsDigestOf(rows: NodeArtifactRow[]): string | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0
  );
  const payload = sorted
    .map((r) => `${r.kind}\t${r.ref}\t${r.digest ?? ""}`)
    .join("\n");
  return createHash("sha256")
    .update(ARTIFACTS_DIGEST_VERSION + "\n" + payload)
    .digest("hex");
}

/**
 * 2.1.3 F2: check_artifacts — hash the referenced artifacts of the given
 * nodes, record the observations, report divergences against the PREVIOUS
 * observation. The snapshot comparison (artifact_changed) is a separate,
 * read-only derivation the support check performs on its own.
 *
 * max_files bounds the WORK: (node, ref) pairs beyond the cap are not touched
 * and reported via truncated: true. Nodes are taken in the order passed, refs
 * in file_refs order — the cut is deterministic.
 */
export async function checkArtifacts(
  db: KnowledgeDB,
  input: CheckArtifactsInput
): Promise<CheckArtifactsOutput> {
  if (!Array.isArray(input.node_ids)) {
    throw new Error("check_artifacts: node_ids обязателен (массив id узлов).");
  }
  const maxFiles = input.max_files ?? 50;
  if (!Number.isFinite(maxFiles) || !Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new Error(
      `check_artifacts: max_files должен быть целым ≥ 1, получено: ${String(input.max_files)}.`
    );
  }
  const cwd = input.cwd ?? process.cwd();

  const output: CheckArtifactsOutput = { checked: 0, changed: [], missing: [], truncated: false };
  const now = new Date().toISOString();

  const seen = new Set<string>();
  outer: for (const nodeId of input.node_ids) {
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const node = db.getNode(nodeId);
    if (!node) continue;
    let refs: string[] = [];
    if (node.file_refs) {
      try {
        const parsed = JSON.parse(node.file_refs);
        if (Array.isArray(parsed)) refs = parsed.filter((r) => typeof r === "string");
      } catch {
        refs = [];
      }
    }
    const existing = new Map(db.getNodeArtifacts(nodeId).map((r) => [`${r.kind}\t${r.ref}`, r]));
    for (const ref of refs) {
      if (output.checked >= maxFiles) {
        output.truncated = true;
        break outer;
      }
      const { kind, rev } = classifyRef(ref);
      const fresh =
        kind === "git_blob"
          ? await hashGitBlob(rev!, ref, cwd)
          : await hashFile(path.isAbsolute(ref) ? ref : path.resolve(cwd, ref));
      const row = existing.get(`${kind}\t${ref}`);

      if (!fresh) {
        // Missing now. The row keeps the last-seen digest in prev_digest so
        // the warning text can say "was → missing, noticed then".
        if (row && row.digest !== null) {
          db.upsertNodeArtifact({
            ...row,
            digest: null,
            prev_digest: row.digest,
            checked_at: now,
            changed_at: now,
          });
        } else {
          db.upsertNodeArtifact({
            node_id: nodeId,
            kind,
            ref,
            digest: null,
            prev_digest: row?.prev_digest ?? null,
            size_bytes: null,
            checked_at: now,
            changed_at: row?.changed_at ?? null,
            checked_by: "agent",
          });
        }
        output.missing.push({ node_id: nodeId, ref, kind, digest: null, missing: true });
        output.checked += 1;
        continue;
      }

      if (!row) {
        // First observation: recorded, never a divergence (nothing to compare).
        db.upsertNodeArtifact({
          node_id: nodeId,
          kind,
          ref,
          digest: fresh.digest,
          prev_digest: null,
          size_bytes: fresh.size,
          checked_at: now,
          changed_at: null,
          checked_by: "agent",
        });
        output.checked += 1;
        continue;
      }

      if (row.digest === null) {
        // Was missing, is back: honest change (old = null), dated for the text.
        db.upsertNodeArtifact({
          ...row,
          digest: fresh.digest,
          size_bytes: fresh.size,
          checked_at: now,
          changed_at: now,
        });
        output.changed.push({ node_id: nodeId, ref, old: null, new: fresh.digest });
        output.checked += 1;
        continue;
      }

      if (fresh.digest === row.digest) {
        // Same content: only the check time moves; prev_digest/changed_at are
        // NOT touched — a steady re-check must not look like a change.
        db.upsertNodeArtifact({ ...row, checked_at: now });
        output.checked += 1;
        continue;
      }

      db.upsertNodeArtifact({
        ...row,
        digest: fresh.digest,
        prev_digest: row.digest,
        size_bytes: fresh.size,
        checked_at: now,
        changed_at: now,
      });
      output.changed.push({ node_id: nodeId, ref, old: row.digest, new: fresh.digest });
      output.checked += 1;
    }
  }

  return output;
}
