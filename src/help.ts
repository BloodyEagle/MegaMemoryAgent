import pc from "picocolors";

/**
 * Общий хелп CLI. `--db` — глобальная опция всех команд, открывающих базу
 * (2.1.4): путь можно задать флагом, переменной MEGAMEMORY_DB_PATH или
 * запустив команду из каталога проекта (.megamemory/knowledge.db).
 */
export function buildHelp(version: string): string {
  return `
${pc.bold(pc.cyan("megamemory"))} ${pc.green(`v${version}`)} ${pc.dim("— persistent project knowledge graph for coding agents")}

${pc.bold("Commands:")}
  ${pc.cyan("(no command)")}    Start the MCP stdio server ${pc.dim("(invoked by your editor)")}
  ${pc.cyan("install")}         Configure editor/agent integration (interactive)
  ${pc.cyan("serve")}           Start the web graph explorer ${pc.dim("(--db PATH)")}
  ${pc.cyan("stats")}           Show knowledge graph statistics ${pc.dim("(--prune trims the call journal; --db PATH)")}
  ${pc.cyan("merge")}           Merge two knowledge.db files
  ${pc.cyan("conflicts")}       List unresolved merge conflicts ${pc.dim("(--db PATH)")}
  ${pc.cyan("resolve")}         Resolve a merge conflict ${pc.dim("(--db PATH)")}
  ${pc.cyan("repair-ids")}      Fix legacy empty/trailing-slash node ids ${pc.dim("(default: dry-run; --db PATH)")}
  ${pc.cyan("migrate")}         Upgrade an upstream v1.6.2 database to the fork schema ${pc.dim("(default: dry-run; --db PATH)")}
  ${pc.cyan("reembed")}         Reindex node embeddings with the current model ${pc.dim("(--batch N; --db PATH)")}
  ${pc.cyan("consolidate")}     Find and merge near-duplicate nodes ${pc.dim("(default: dry-run; --db PATH)")}
  ${pc.cyan("digest")}          Rebuild module digest nodes ${pc.dim("(default: dry-run; --db PATH)")}
  ${pc.cyan("export --md <dir>")} Export the graph to markdown files ${pc.dim("(--check for CI; --db PATH)")}
  ${pc.cyan("doctor")}          Health check of the current database ${pc.dim("(exit 1 on problems; --db PATH)")}
  ${pc.cyan("eval")}            Measure search recall@k on the eval set ${pc.dim("(fixtures/eval.jsonl; --db PATH)")}

${pc.bold("Options:")}
  ${pc.cyan("--target")} ${pc.dim("NAME")}    Install target (opencode, claudecode, antigravity, codex)
  ${pc.cyan("--port")} ${pc.dim("PORT")}     Port for the web explorer ${pc.dim("(default: 4321)")}
  ${pc.cyan("--into")} ${pc.dim("FILE")}     Output path for merge ${pc.dim("(default: overwrites file1)")}
  ${pc.cyan("--left-label")}    Label for left side in merge ${pc.dim("(default: left)")}
  ${pc.cyan("--right-label")}   Label for right side in merge ${pc.dim("(default: right)")}
  ${pc.cyan("--keep")}          Resolution strategy: left, right, or both
  ${pc.cyan("--json")}          Machine-readable output for conflicts
  ${pc.cyan("--db")} ${pc.dim("PATH")}       Path to knowledge.db for every command that opens the
                database ${pc.dim("(sources: --db, MEGAMEMORY_DB_PATH, ./.megamemory/knowledge.db)")}
  ${pc.cyan("--help, -h")}      Show this help
  ${pc.cyan("--version, -v")}   Show version

${pc.bold("Examples:")}
  ${pc.dim("$")} megamemory install                                   ${pc.dim("Interactive editor integration setup")}
  ${pc.dim("$")} megamemory install --target claudecode              ${pc.dim("Non-interactive Claude Code setup")}
  ${pc.dim("$")} megamemory serve                                     ${pc.dim(`Open graph explorer at ${pc.underline("http://localhost:4321")}`)}
  ${pc.dim("$")} megamemory serve --port 8080                         ${pc.dim("Custom port")}
  ${pc.dim("$")} megamemory merge main.db feature.db --into merged.db ${pc.dim("Merge two knowledge DBs")}
  ${pc.dim("$")} megamemory conflicts                                 ${pc.dim("View unresolved conflicts")}
  ${pc.dim("$")} megamemory resolve <group-id> --keep left            ${pc.dim("Resolve a conflict")}
  ${pc.dim("$")} megamemory doctor --db /path/to/knowledge.db         ${pc.dim("Check a specific database")}
  ${pc.dim("$")} megamemory repair-ids --apply                        ${pc.dim("Rename broken ids after backup")}
`.trim();
}
