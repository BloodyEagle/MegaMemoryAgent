import fs from "fs";
import os from "os";
import path from "path";

// ---- Instructions staleness signal (plan 3 step 7) ----
//
// The install command writes a workflow snippet into the agent's instruction
// files (AGENTS.md / CLAUDE.md) and into commands/*.md. The base and the
// server keep updating, the prompts do not — after `npm update -g` the agent
// keeps working by outdated rules and has no way to notice. The agent cannot
// see stderr, so the signal travels in the same MCP responses it already
// reads: list_roots and understand carry instructions_stale /
// instructions_version / server_version.

/** Opening token of the versioned stamp written by install (step 7.2). */
export const INSTRUCTIONS_STAMP_MARKER = "<!-- megamemory:instructions";

/**
 * Managed-block marker of the previous generation (v2-era snippets). Its
 * presence means the user DID run install, just with an older package —
 * the block is ours to refresh, and the agent should be told to re-run it.
 */
const LEGACY_SNIPPET_MARKER = "megamemory-snippet";

export function instructionsStamp(version: string): string {
  return `${INSTRUCTIONS_STAMP_MARKER} v${version} -->`;
}

/**
 * Extract the package version from a stamp written by install. Returns null
 * when the content carries no versioned stamp. The leading "v" is stripped:
 * the stamp reads `v2.0.0-fork.1`, the field reports `2.0.0-fork.1`.
 */
export function extractInstructionsVersion(content: string): string | null {
  const match = content.match(/<!--\s*megamemory:instructions\s+v?(\S+?)\s*-->/);
  return match ? match[1] : null;
}

/**
 * Where install may have written the instructions block: the project-level
 * files first (they shadow the global ones), then the global instruction
 * files of every install target. Mirrors the paths install.ts writes to,
 * including the OPENCODE_CONFIG_DIR override.
 */
export function instructionsCandidates(): string[] {
  const home = os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  const opencodeDir = process.env.OPENCODE_CONFIG_DIR ?? path.join(xdg, "opencode");
  const cwd = process.cwd();
  return [
    path.join(cwd, "AGENTS.md"),
    path.join(cwd, "CLAUDE.md"),
    path.join(opencodeDir, "AGENTS.md"),
    path.join(home, ".claude", "CLAUDE.md"),
    path.join(home, ".codex", "AGENTS.md"),
  ];
}

export interface InstructionsStatus {
  /** true = the found instructions block was written by another version. */
  instructions_stale: boolean;
  /** Version from the stamp, null when nothing stamped was found. */
  instructions_version: string | null;
  /** Version of the running server. */
  server_version: string;
}

/**
 * Compare the stamp in the first instruction file that carries one against
 * the server version. Read fresh on every call — the file can change (and
 * the server keep running) at any moment. No instructions file at all ->
 * stale: false, version: null: a user who never installed the snippet must
 * not be warned about it.
 */
export function instructionsStatus(
  serverVersion: string,
  candidates?: string[]
): InstructionsStatus {
  for (const file of candidates ?? instructionsCandidates()) {
    let content: string;
    try {
      if (!fs.existsSync(file)) continue;
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue; // unreadable file — try the next candidate
    }
    const version = extractInstructionsVersion(content);
    if (version !== null) {
      return {
        instructions_stale: version !== serverVersion,
        instructions_version: version,
        server_version: serverVersion,
      };
    }
    if (content.includes(LEGACY_SNIPPET_MARKER)) {
      // Managed block from an older generation: no comparable stamp, but it
      // IS ours — outdated until the user re-runs install.
      return {
        instructions_stale: true,
        instructions_version: null,
        server_version: serverVersion,
      };
    }
  }
  return {
    instructions_stale: false,
    instructions_version: null,
    server_version: serverVersion,
  };
}
