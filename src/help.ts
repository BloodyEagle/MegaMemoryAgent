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
  ${pc.cyan("(no command)")}    Start the MCP stdio server ${pc.dim("(invoked by your editor; global database/repository options apply)")}
  ${pc.cyan("install")}         Configure integrations ${pc.dim("[--target NAME[,NAME...]]; default: interactive")}
  ${pc.cyan("serve")}           Start the loopback-only web explorer ${pc.dim("[--port PORT] [--host HOST]; --db PATH")}
  ${pc.cyan("stats")}           Show graph statistics ${pc.dim("[--prune] [--funnel] [--json]; --db PATH")}
  ${pc.cyan("merge")}           Merge databases ${pc.dim("<FILE1> <FILE2> [--into FILE] [--left-label NAME] [--right-label NAME]")}
  ${pc.cyan("conflicts")}       List unresolved merge conflicts ${pc.dim("[--json]; --db PATH")}
  ${pc.cyan("resolve")}         Resolve a merge conflict ${pc.dim("<GROUP_ID> --keep left|right|both; --db PATH")}
  ${pc.cyan("repair-ids")}      Fix legacy empty/trailing-slash node ids ${pc.dim("[--dry-run|--apply]; default: dry-run; --db PATH")}
  ${pc.cyan("migrate")}         Upgrade an upstream v1.6.2 database ${pc.dim("[--dry-run|--apply]; default: dry-run; --db PATH")}
  ${pc.cyan("reembed")}         Reindex node embeddings ${pc.dim("[--batch N]; default: 16; --db PATH")}
  ${pc.cyan("consolidate")}     Find and merge near-duplicate nodes ${pc.dim("[--threshold RATIO] [--limit N] [--dry-run|--apply]; --db PATH")}
  ${pc.cyan("digest")}          Rebuild derived digest nodes ${pc.dim("[--module ID] [--apply]; default: dry-run; --db PATH")}
  ${pc.cyan("export")}          Export graph nodes to Markdown ${pc.dim("--md DIR [--check]; --db PATH")}
  ${pc.cyan("doctor")}          Run database health checks ${pc.dim("(RW open; may migrate; exit 1 on problems; --db PATH)")}
  ${pc.cyan("eval")}            Measure search recall@k ${pc.dim("[--file FILE] [--k N] [--min RATIO]; --db PATH")}
  ${pc.cyan("guide")}           Print agent onboarding and worked-session guidance
  ${pc.cyan("bench")}           Measure graph orientation cost against files/TE ${pc.dim("--questions FILE [options]; --db PATH")}
  ${pc.cyan("expire")}          Set valid_until on selected nodes ${pc.dim("(--ids IDS|--report FILE) --until DATE|past [--apply]; --db PATH")}

${pc.bold("Global and MCP options:")}
  ${pc.cyan("--db")} ${pc.dim("PATH")}       Path to knowledge.db ${pc.dim("(--db=PATH also accepted; then MEGAMEMORY_DB_PATH; default ./.megamemory/knowledge.db)")}
  ${pc.cyan("--repo")} ${pc.dim("PATH")}     MCP startup repository for git:tag/commit/branch refs
                ${pc.dim("(--repo=PATH also accepted; default: database directory; repins git refs for this server)")}
  ${pc.cyan("--help, -h")}      Show this help
  ${pc.cyan("--version, -v")}   Show version

${pc.bold("Command options:")}
  ${pc.cyan("--target")} ${pc.dim("NAME[,NAME...]")}  install target(s), repeatable
                ${pc.dim("(opencode | claudecode | antigravity | codex; absent: interactive selection)")}
  ${pc.cyan("--port")} ${pc.dim("PORT")}     serve port ${pc.dim("(default: 4321)")}
  ${pc.cyan("--host")} ${pc.dim("HOST")}     serve address ${pc.dim("(default: 127.0.0.1; allowed: 127.0.0.1 or ::1)")}
  ${pc.cyan("--prune")}         stats: apply timeline retention cleanup before reporting
  ${pc.cyan("--funnel")}        stats: append the understand → follow-up → write funnel
  ${pc.cyan("--json")}          stats --funnel: JSON-only without --prune; conflicts: machine-readable output
  ${pc.cyan("--into")} ${pc.dim("FILE")}     merge output ${pc.dim("(default: overwrite FILE1 via a temporary file)")}
  ${pc.cyan("--left-label")} ${pc.dim("NAME")}  merge source label ${pc.dim("(default: left)")}
  ${pc.cyan("--right-label")} ${pc.dim("NAME")} merge source label ${pc.dim("(default: right)")}
  ${pc.cyan("--keep")} ${pc.dim("SIDE")}     resolve strategy ${pc.dim("(required: left | right | both)")}
  ${pc.cyan("--dry-run")}       repair-ids/migrate/consolidate: report without writing ${pc.dim("(default)")}
  ${pc.cyan("--apply")}         repair-ids/migrate/consolidate: write changes; digest: build; expire: set dates
  ${pc.cyan("--batch")} ${pc.dim("N")}       reembed batch size ${pc.dim("(leading positive base-10 integer; default: 16)")}
  ${pc.cyan("--threshold")} ${pc.dim("RATIO")} consolidate cosine threshold ${pc.dim("(0..1; default: 0.95)")}
  ${pc.cyan("--limit")} ${pc.dim("N")}       consolidate global output/apply pair cap ${pc.dim("(positive integer; default: 100; large groups also cap 50 pairs per node)")}
  ${pc.cyan("--module")} ${pc.dim("ID")}     digest one parent id ${pc.dim("(default: every parent with at least 5 eligible children)")}
  ${pc.cyan("--md")} ${pc.dim("DIR")}        export destination ${pc.dim("(required)")}
  ${pc.cyan("--check")}         export: compare DIR with the current render and exit 1 on drift
  ${pc.cyan("--file")} ${pc.dim("FILE")}     eval JSONL set ${pc.dim("(default: fixtures/eval.jsonl)")}
  ${pc.cyan("--k")} ${pc.dim("N")}           eval recall cutoff ${pc.dim("(positive integer; default: 10)")}
  ${pc.cyan("--min")} ${pc.dim("RATIO")}     eval pass threshold ${pc.dim("(0..1; default: 0.8)")}

${pc.bold("Bench options:")}
  ${pc.cyan("--questions")} ${pc.dim("FILE")}  JSONL questions ${pc.dim('(required; {"id"?,"query","expect_nodes"?,...})')}
  ${pc.cyan("--baseline")} ${pc.dim("MODE")} baseline ${pc.dim("(files | te | both; default: files)")}
  ${pc.cyan("--te-exec")} ${pc.dim("PROG")}  structured runner executable, spawned without a shell
  ${pc.cyan("--te-arg")} ${pc.dim("ARG")}    structured runner argument, repeatable; one argument must contain {query}
                ${pc.dim("(requires --te-exec; default argv when omitted: {query})")}
  ${pc.cyan("--te-cmd")} ${pc.dim("CMD")}    trusted shell template containing {query}; mutually exclusive with --te-exec
                ${pc.dim("(parsed by cmd.exe/sh, so shell quoting and environment expansion apply)")}
  ${pc.cyan("--file-limit")} ${pc.dim("KB")} files over this size are token-estimated ${pc.dim("(default: 200)")}
  ${pc.cyan("--ref-root")} ${pc.dim("PATH")}  extra root for relative file_refs, repeatable
                ${pc.dim("(first hit wins; order: question roots, --ref-root, git root, cwd)")}
  ${pc.cyan("--files-top")} ${pc.dim("N")}   files baseline over the first N unique output files
                ${pc.dim("(default: 0 = all; 3 approximates a live agent; compare hit_rate@1 with hit_rate)")}

${pc.bold("Expire options:")}
  ${pc.cyan("--ids")} ${pc.dim("IDS")}       comma-separated node ids ${pc.dim("(mutually exclusive with --report)")}
  ${pc.cyan("--report")} ${pc.dim("FILE")}   JSON report; use candidates whose expire field is true
  ${pc.cyan("--until")} ${pc.dim("DATE|past")} parseable expiry date or yesterday ${pc.dim("(required)")}
  ${pc.cyan("--apply")}         write expiry dates ${pc.dim("(default: dry-run)")}

${pc.bold("Examples:")}
  ${pc.dim("$")} megamemory install --target claudecode
  ${pc.dim("$")} megamemory serve --port 8080 --host ::1
  ${pc.dim("$")} megamemory stats --funnel --json --db ./knowledge.db
  ${pc.dim("$")} megamemory merge main.db feature.db --into merged.db
  ${pc.dim("$")} megamemory resolve <group-id> --keep left
  ${pc.dim("$")} megamemory consolidate --threshold 0.95 --limit 100 --apply
  ${pc.dim("$")} megamemory eval --file fixtures/eval.jsonl --k 10 --min 0.8
  ${pc.dim("$")} megamemory bench --questions questions.jsonl --baseline files
  ${pc.dim("$")} megamemory expire --ids a,b --until past --apply
`.trim();
}
