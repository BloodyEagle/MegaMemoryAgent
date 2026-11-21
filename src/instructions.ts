import fs from "fs";
// План 29: пути инструкций берутся из install-paths.ts — того же источника,
// которым пользуется install. Рукописный список кандидатов отставал от целей
// установщика: zcode и kilo не детектировались вовсе.
import {
  agentsCanonical,
  claudeAgents,
  codexAgentsCandidates,
  kiloAgents,
  kiloRules,
  opencodeAgents,
  projectAgents,
  projectClaude,
  zcodeAgents,
} from "./install-paths.js";
// План 32: устаревание — это направление (блок СТАРШЕ сервера), а не любое
// несовпадение версий: блок, написанный более новым билдом (клиент обновился,
// сервер в открытой сессии ещё старый), не тревога — действие рестарт клиента,
// а не install (он идемпотентен и сигнал не гасит).
import { compareVersions } from "./version-compare.js";

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
 *
 * План 29: файлы правил kilo несут другой маркер —
 * `<!-- megamemory-snippet v<версия> -->` (kiloManagedBlock в install.ts).
 * Его версия сравнивается так же; маркер без версии (и legacy-форма
 * `megamemory-snippet:`) под regex не подходит и уходит в legacy-ветку
 * ниже — stale: true, version: null.
 */
export function extractInstructionsVersion(content: string): string | null {
  const stamp = content.match(/<!--\s*megamemory:instructions\s+v?(\S+?)\s*-->/);
  if (stamp) return stamp[1];
  const snippet = content.match(/<!--\s*megamemory-snippet\s+v?(\d\S*?)\s*-->/);
  return snippet ? snippet[1] : null;
}

/**
 * Where install may have written the instructions block: the project-level
 * files first (they shadow the global ones), then the global instruction
 * files of every install target (plan 29 — the list is assembled from the
 * same install-paths.ts functions install writes with, so a new target
 * cannot drift away silently).
 *
 * ~/.agents/AGENTS.md is a symlink to the kilo rules file it points at:
 * dedup by realpath keeps it from being read twice per MCP response (on a
 * missing or broken link realpathSync throws — the literal path stays in
 * the list as is).
 *
 * План 30: Codex развёрнут в codexAgentsCandidates() — активный
 * $CODEX_HOME/AGENTS.md раньше ~/.codex/AGENTS.md (fallback для блоков,
 * оставшихся с установки до появления переменной). До этого детектор читал
 * только ~/.codex и при непустой переменной не видел блок, который цель
 * codex кладёт в активный профиль.
 */
export function instructionsCandidates(): string[] {
  const paths = [
    projectAgents(),
    projectClaude(),
    opencodeAgents(),
    claudeAgents(),
    ...codexAgentsCandidates(),
    kiloAgents(true),
    zcodeAgents(true),
    agentsCanonical(true),
    kiloRules(false, "jsonc"),
    kiloRules(true, "jsonc"),
  ];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const candidate of paths) {
    let key = candidate;
    try {
      key = fs.realpathSync(candidate);
    } catch {
      // не существует (в том числе битая ссылка) — сравниваем по литеральному пути
    }
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

export interface InstructionsStatus {
  /**
   * true = the found instructions block is OLDER than the running server
   * (plan 32). A block newer than the server is not stale — the client was
   * updated first, the action is a client restart, not `install`.
   */
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
 *
 * План 32: версии сравниваются по порядку, а не на равенство. stale — только
 * блок старше сервера; блок новее — не устаревание (рестарт клиента, а не
 * install); непарсящаяся версия (vNext, мусор) — консервативно stale.
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
      const order = compareVersions(version, serverVersion);
      return {
        instructions_stale: order === null ? true : order < 0,
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
