/**
 * P2 (план 20+21 v3 §11): инкрементальная актуальность — обратный индекс,
 * адресная перепроверка, adapter (пилот), границы проверки.
 *
 * Контракт (P2.1–P2.3):
 * - Обратный индекс «источник → использующие записи» — восстановимый кэш
 *   РЯДОМ с БД (не в БД, схема 14 не трогается); повреждённый/старый кэш
 *   перестраивается из БД молча — вердикты от этого не меняются.
 * - Проверка — явное opt-in действие, проверяет СВЯЗАННЫЕ записи, не весь
 *   граф; префикс не выдаётся за весь граф (unchecked_sources/partial).
 * - Один физический источник хешируется один раз за проверку; доказательство —
 *   sha256 содержимого (одинаковые mtime/size при иных bytes — changed).
 * - TOCTOU: изменение входов в середине проверки (детерминированная инъекция)
 *   → unstable, записи unknown — стабильный снимок не объявляется.
 * - Проверка только читает: ни наблюдений, ни снимков, ни записей графа;
 *   reuse-квалификация не поднимается.
 * - Git: dirty tree (staged/unstaged/untracked/rename), перемещение тега,
 *   два репозитория с одинаковым путём (other_repo), HEAD — не доказательство.
 * - Adapter (P2.2, пилот): конфиг-точка, capability-детект, неоднозначное/
 *   пропавшее определение — явный ambiguous/missing (не первый совпадение),
 *   номера строк — текущее разрешение, фолбэк файлового уровня ЯВНЫЙ.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { checkArtifacts } from "../artifacts.js";
import { trailSaveWithPassport } from "../tools.js";
import {
  checkFreshness,
  buildFreshnessIndex,
  freshnessIndexCachePath,
  loadFreshnessIndex,
  normalizeSourceKey,
} from "../freshness.js";
import { adapterRdepsOfFile, adapterResolveSymbol, resolveAdapterConfig } from "../code-adapter.js";
import type { FreshnessIndex } from "../types.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let projDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-freshness-"));
  projDir = path.join(tmpDir, "proj");
  fs.mkdirSync(projDir, { recursive: true });
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
});

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

function writeProjFile(rel: string, content: string): void {
  const abs = path.join(projDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function nodeWithRef(id: string, refs: string[], kind = "decision", summary = `s-${id}`): void {
  db.insertNode({ id, name: id.toUpperCase(), kind, summary, file_refs: refs });
}

/** Создать git-репозиторий в projDir с одним коммитом (аргументы фиксированы). */
function gitInit(): void {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: projDir, stdio: "ignore" });
  fs.writeFileSync(path.join(projDir, "README.md"), "# seed\n", "utf8");
  git(["init"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  git(["add", "."]);
  git(["commit", "-m", "init"]);
}

const sha256File = (rel: string): string =>
  crypto.createHash("sha256").update(fs.readFileSync(path.join(projDir, rel))).digest("hex");

function gitCommitAll(): void {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  execFileSync("git", ["add", "."], { cwd: projDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: projDir, stdio: "ignore" });
}

/** Проверка не пишет в БД: снимок состава таблиц до/после. */
function tableCounts(): Record<string, number> {
  const count = (sql: string): number =>
    (db.execSqlAll(sql) as Array<{ c: number }>)[0]?.c ?? -1;
  const counts: Record<string, number> = {
    nodes: count("SELECT COUNT(*) AS c FROM nodes"),
    edges: count("SELECT COUNT(*) AS c FROM edges"),
    trails: count("SELECT COUNT(*) AS c FROM trails"),
    timeline: count("SELECT COUNT(*) AS c FROM timeline"),
  };
  if (db.hasNodeArtifactsTable()) counts.node_artifacts = count("SELECT COUNT(*) AS c FROM node_artifacts");
  if (db.hasSupportBaselinesTable()) counts.support_baselines = count("SELECT COUNT(*) AS c FROM support_baselines");
  return counts;
}

describe("P2.1: обратный индекс (восстановимый кэш)", () => {
  it("индекс собирается из file_refs узлов, наблюдений и областей паспортов", async () => {
    nodeWithRef("d1", ["src/auth/refresh.ts", "src/auth/loop.ts:10-20"]);
    nodeWithRef("f1", ["src/auth/refresh.ts"], "fact");
    writeProjFile("src/auth/refresh.ts", "export function refresh() {}\n");
    writeProjFile("src/auth/loop.ts", "export const I = 10;\n");
    await checkArtifacts(db, { node_ids: ["f1"], cwd: projDir });

    const index = buildFreshnessIndex(db);
    const refreshKey = "src/auth/refresh.ts";
    const entries = index.entries[refreshKey] ?? [];
    // d1 (file_ref) + f1 (file_ref) + f1 (artifact-наблюдение)
    expect(entries.filter((e) => e.record === "node" && e.id === "d1").length).toBe(1);
    expect(entries.filter((e) => e.record === "node" && e.id === "f1" && e.via === "node_file_ref").length).toBe(1);
    expect(entries.filter((e) => e.record === "node" && e.id === "f1" && e.via === "artifact").length).toBe(1);
    // локатор снимается: ключ "src/auth/loop.ts" содержит запись d1
    expect((index.entries["src/auth/loop.ts"] ?? []).some((e) => e.id === "d1")).toBe(true);
  });

  it("кэш рядом с БД валидируется отпечатком; повреждённый и старый кэш перестраиваются — вердикты те же", async () => {
    nodeWithRef("d1", ["src/a.ts"]);
    writeProjFile("src/a.ts", "export const A = 1;\n");
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });
    const cachePath = freshnessIndexCachePath(db.dbPath);

    // 1. Нет файла — создаётся при первой проверке.
    const r1 = await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir });
    expect(r1.sources[0]?.status).toBe("unchanged");
    expect(fs.existsSync(cachePath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(cachePath, "utf8")) as FreshnessIndex;
    expect(saved.index_format).toBe(1);
    expect(saved.source_fingerprint).toBe(buildFreshnessIndex(db).source_fingerprint);

    // 2. Повреждённый JSON — тихий rebuild, проверка работает.
    fs.writeFileSync(cachePath, "{broken json", "utf8");
    const r2 = await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir });
    expect(r2.sources[0]?.status).toBe("unchanged");

    // 3. «Старый» кэш (чужой отпечаток исходных данных) — rebuild.
    const stale: FreshnessIndex = {
      ...buildFreshnessIndex(db),
      source_fingerprint: "0".repeat(64),
      built_at: "2020-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(cachePath, JSON.stringify(stale), "utf8");
    const r3 = await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir });
    expect(r3.sources[0]?.status).toBe("unchanged");
    const rewritten = JSON.parse(fs.readFileSync(cachePath, "utf8")) as FreshnessIndex;
    expect(rewritten.source_fingerprint).not.toBe("0".repeat(64));

    // 4. Кэш другой версии формата — rebuild.
    const wrongVersion = { ...stale, index_format: 99, source_fingerprint: buildFreshnessIndex(db).source_fingerprint };
    fs.writeFileSync(cachePath, JSON.stringify(wrongVersion), "utf8");
    const r4 = await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir });
    expect(r4.sources[0]?.status).toBe("unchanged");

    // loadFreshnessIndex возвращает валидный кэш без перезаписи.
    const loaded = loadFreshnessIndex(db);
    expect(loaded.source_fingerprint).toBe(rewritten.source_fingerprint);
  });

  it("невалидные записи кэша (узел-призрак) не повышают доверие: запись unknown", async () => {
    nodeWithRef("d1", ["src/a.ts"]);
    writeProjFile("src/a.ts", "export const A = 1;\n");
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });
    const cachePath = freshnessIndexCachePath(db.dbPath);
    await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir });
    // Кэш, валидный по отпечатку, но содержащий запись-призрак (повреждение кэша,
    // а не БД): узла ghost в БД нет — доверие не выдаётся.
    const index = buildFreshnessIndex(db);
    index.entries["src/a.ts"] = [
      ...(index.entries["src/a.ts"] ?? []),
      { record: "node", id: "ghost-node", via: "node_file_ref", ref: "src/a.ts" },
    ];
    fs.writeFileSync(cachePath, JSON.stringify(index), "utf8");
    const r = await checkFreshness(db, { sources: ["src/a.ts"], repo_root: projDir });
    expect(r.sources[0]?.status).toBe("unchanged");
    const ghost = r.records.find((x) => x.id === "ghost-node");
    expect(ghost?.state).toBe("unknown");
    expect(ghost?.reasons.join(" ")).toContain("не найден в БД");
  });
});

describe("P2.1: адресная перепроверка связанных записей", () => {
  it("неизменный код: unchanged + запись fresh + expected_versions", async () => {
    nodeWithRef("d1", ["src/auth/refresh.ts"]);
    writeProjFile("src/auth/refresh.ts", "export function refresh() { return 42; }\n");
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });

    const r = await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir });
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]?.status).toBe("unchanged");
    expect(r.records).toHaveLength(1);
    expect(r.records[0]?.state).toBe("fresh");
    expect(r.summary.affected).toBe(0);
    expect(r.expected_versions).toHaveLength(1);
    expect(r.expected_versions[0]?.sha256).toBe(sha256File("src/auth/refresh.ts"));
  });

  it("изменение используемой функции: changed + запись stale_input, не «ложное»", async () => {
    nodeWithRef("d1", ["src/auth/refresh.ts"]);
    writeProjFile("src/auth/refresh.ts", "export function refresh() { return 42; }\n");
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });
    writeProjFile("src/auth/refresh.ts", "export function refresh() { return 43; }\n");

    const r = await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir });
    expect(r.sources[0]?.status).toBe("changed");
    expect(r.records[0]?.state).toBe("stale_input");
    expect(r.records[0]?.reasons.join(" ")).toContain("не объявляется автоматически ложным");
    expect(r.summary.affected).toBe(1);
  });

  it("посторонняя правка: проверенные записи fresh, чужое изменение видно в dirty", async () => {
    gitInit();
    nodeWithRef("d1", ["src/a.ts"]);
    writeProjFile("src/a.ts", "export const A = 1;\n");
    writeProjFile("src/unrelated.ts", "export const U = 1;\n");
    gitCommitAll();
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });
    writeProjFile("src/unrelated.ts", "export const U = 2;\n");

    const r = await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir });
    expect(r.sources[0]?.status).toBe("unchanged");
    expect(r.records[0]?.state).toBe("fresh");
    expect(r.repo.dirty.unstaged).toContain("src/unrelated.ts");
  });

  it("изменение вызываемого объявления: зависимые записи помечаются через import-граф adapter", async () => {
    // Stub adapter: rdeps src/callee.ts → src/caller.ts.
    const scriptsDir = path.join(projDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptsDir, "graph-tool.js"),
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const kv = {};",
        "for (const a of process.argv.slice(2)) { const i = a.indexOf('='); if (i > 0) kv[a.slice(0, i)] = a.slice(i + 1); }",
        "const idx = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'stub-index.json'), 'utf8'));",
        "if (kv.op === 'info') { console.log(JSON.stringify({ projectType: 'ts' })); }",
        "else if (kv.op === 'symbol') {",
        "  const defs = (idx.symbols[kv.name] || []).filter(d => !kv.in || d.owner === kv.in);",
        "  console.log(JSON.stringify({ name: kv.name, definedIn: defs }));",
        "} else if (kv.op === 'rdeps') {",
        "  const r = idx.rdeps[kv.file] || { importedBy: [], importedByTotal: 0 };",
        "  console.log(JSON.stringify(Object.assign({ file: kv.file, scope: { scanRoot: 'src' }, completeness: { complete: true } }, r)));",
        "} else { console.log(JSON.stringify({ error: 'unknown op' })); }",
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(projDir, "stub-index.json"),
      JSON.stringify({
        symbols: {},
        rdeps: {
          "src/callee.ts": { importedBy: [{ file: "src/caller.ts", kind: "file", level: 1 }], importedByTotal: 1 },
        },
      }),
      "utf8"
    );

    nodeWithRef("d1", ["src/caller.ts"]);
    nodeWithRef("f-callee", ["src/callee.ts"], "fact");
    writeProjFile("src/callee.ts", "export function callee() {}\n");
    writeProjFile("src/caller.ts", "import { callee } from './callee.js';\nexport function caller() { return callee(); }\n");
    await checkArtifacts(db, { node_ids: ["d1", "f-callee"], cwd: projDir });
    writeProjFile("src/callee.ts", "export function callee(x: number) {}\n");

    const r = await checkFreshness(db, {
      sources: ["src/callee.ts"],
      with_dependencies: true,
      adapter: { graph_tool: scriptsDir },
      repo_root: projDir,
    });
    expect(r.sources[0]?.status).toBe("changed");
    expect(r.dependencies).not.toBeNull();
    expect(r.dependencies?.[0]?.dependents).toContain("src/caller.ts");
    // Запись цитирует только caller (его байты не менялись) — потенциально
    // затронута через зависимость, это НЕ «всё чисто».
    const rec = r.records.find((x) => x.id === "d1");
    expect(rec).toBeDefined();
    expect(rec?.reasons.join(" ")).toContain("import-граф");
    expect(rec?.reasons.join(" ")).toContain("не доказывают независимость");
    // Обход — static import-граф adapter, объявленный scope (не весь граф).
    expect(rec?.reasons.join(" ")).toContain("static");
    expect(r.dependencies?.[0]?.scope).toBe("src");
  });

  it("изменение конфига/lockfile в области паспорта: запись stale_input", async () => {
    nodeWithRef("d1", ["src/app.ts"], "fact");
    writeProjFile("src/app.ts", "export const APP = 1;\n");
    writeProjFile("tsconfig.json", '{ "compilerOptions": { "strict": true } }\n');
    writeProjFile("package-lock.json", '{ "lockfileVersion": 3 }\n');
    const saved = await trailSaveWithPassport(db, {
      node_ids: ["d1"],
      summary: "Строгий режим и состав зависимостей — существенные входы разбора.",
      name: "passport-config",
      repo_root: projDir,
      passport: {
        task_type: "implementation_analysis",
        goal: "Разбор конфигурации и зависимостей",
        scope_files: ["src/app.ts", "tsconfig.json", "package-lock.json"],
      },
    });
    writeProjFile("package-lock.json", '{ "lockfileVersion": 3, "changed": true }\n');

    const r = await checkFreshness(db, { trail_ids: [saved.passport.trail_id], repo_root: projDir });
    expect(r.records).toHaveLength(1);
    expect(r.records[0]?.state).toBe("stale_input");
    expect(r.records[0]?.reasons.join(" ")).toContain("package-lock.json");
    // Остальные источники области проверены: changed только у lockfile.
    const lock = r.sources.find((s) => normalizeSourceKey(s.source) === "package-lock.json");
    const app = r.sources.find((s) => normalizeSourceKey(s.source) === "src/app.ts");
    expect(lock?.status).toBe("changed");
    expect(app?.status).toBe("unchanged");
  });

  it("новый файл, появившийся после записи версии: changed («появился после проверки»)", async () => {
    // Наблюдение зафиксировало missing (файла не было), затем файл создали.
    nodeWithRef("d1", ["src/new.ts"]);
    writeProjFile("src/other.ts", "x");
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });
    writeProjFile("src/new.ts", "export const NEW = 1;\n");

    const r = await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir });
    expect(r.sources[0]?.status).toBe("changed");
    expect(r.records[0]?.state).toBe("stale_input");
  });

  it("бюджет max_files: срез детерминированный, остаток skipped + truncated", async () => {
    nodeWithRef("d1", ["src/a.ts", "src/b.ts", "src/c.ts"]);
    for (const f of ["src/a.ts", "src/b.ts", "src/c.ts"]) writeProjFile(f, `export const F = "${f}";\n`);

    const r = await checkFreshness(db, { node_ids: ["d1"], max_files: 2, repo_root: projDir });
    const statuses = r.sources.map((s) => s.status);
    expect(statuses.filter((s) => s === "skipped")).toHaveLength(1);
    expect(r.summary.truncated).toBe(true);
    expect(r.summary.truncated_by).toBe("max_files");
    expect(r.summary.checked).toBe(2);
    // Префикс не выдаётся за весь граф.
    expect(r.records[0]?.state).toBe("partial");
    expect(r.records[0]?.unchecked_sources).toHaveLength(1);
    expect(r.records[0]?.reasons.join(" ")).toContain("НЕ весь граф");
  });

  it("unobserved: узел без записанной версии — честный статус, дайджест в expected_versions", async () => {
    nodeWithRef("d1", ["src/a.ts"]);
    writeProjFile("src/a.ts", "export const A = 1;\n");

    const r = await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir });
    expect(r.sources[0]?.status).toBe("unobserved");
    expect(r.sources[0]?.note).toContain("записанной версии");
    expect(r.records[0]?.state).toBe("unknown");
    expect(r.records[0]?.checked_sources[0]?.status).toBe("unobserved");
    expect(r.records[0]?.reasons.join(" ")).toContain("собственной записанной версии");
    expect(r.expected_versions[0]?.sha256).toBe(sha256File("src/a.ts"));
  });

  it("A04: общая сводка changed не подменяет собственные версии связанных записей", async () => {
    nodeWithRef("old", ["src/shared.ts"]);
    nodeWithRef("current", ["src/shared.ts"]);
    nodeWithRef("unobserved", ["src/shared.ts:1-10"]);
    writeProjFile("src/shared.ts", "export const S = 1;\n");
    await checkArtifacts(db, { node_ids: ["old"], cwd: projDir });
    writeProjFile("src/shared.ts", "export const S = 2;\n");
    await checkArtifacts(db, { node_ids: ["current"], cwd: projDir });

    const r = await checkFreshness(db, { sources: ["src/shared.ts"], repo_root: projDir });
    expect(r.sources[0]?.status).toBe("changed");
    expect(r.records.find((x) => x.id === "old")?.state).toBe("stale_input");
    expect(r.records.find((x) => x.id === "current")?.state).toBe("fresh");
    expect(r.records.find((x) => x.id === "unobserved")?.state).toBe("unknown");
    expect(r.records.find((x) => x.id === "current")?.checked_sources[0]?.status).toBe("unchanged");
    expect(r.records.find((x) => x.id === "unobserved")?.checked_sources[0]?.status).toBe("unobserved");
    expect(r.summary.affected).toBe(1);
  });

  it("A04: частичное покрытие собственными наблюдениями не объявляется fresh", async () => {
    nodeWithRef("d1", ["src/a.ts"]);
    writeProjFile("src/a.ts", "export const A = 1;\n");
    writeProjFile("src/b.ts", "export const B = 1;\n");
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });
    db.updateNode("d1", { file_refs: ["src/a.ts", "src/b.ts"] });

    const r = await checkFreshness(db, { sources: ["src/a.ts"], repo_root: projDir });
    expect(r.records[0]?.state).toBe("partial");
    expect(r.records[0]?.checked_sources.map((s) => s.status)).toEqual(["unchanged", "unobserved"]);
    expect(r.records[0]?.reasons.join(" ")).toContain("собственной записанной версии");
  });

  it("git_blob источник проверяется без записи наблюдений", async () => {
    gitInit();
    writeProjFile("src/a.ts", "export const A = 1;\n");
    gitInitCommit();
    const r = await checkFreshness(db, { sources: ["HEAD:src/a.ts"], repo_root: projDir });
    expect(r.sources[0]?.kind).toBe("git_blob");
    expect(r.sources[0]?.status).toBe("unobserved");
    expect(r.sources[0]?.current_digest).toBe(sha256File("src/a.ts"));
  });

  function gitInitCommit(): void {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    execFileSync("git", ["add", "."], { cwd: projDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "a"], { cwd: projDir, stdio: "ignore" });
  }
});

describe("P2.1: git-интеграция", () => {
  it("dirty tree: staged/unstaged/untracked и git_state источника; HEAD не доказательство", async () => {
    gitInit();
    nodeWithRef("d1", ["src/a.ts"]);
    writeProjFile("src/a.ts", "export const A = 1;\n");
    writeProjFile("src/staged.ts", "export const S = 1;\n");
    gitCommitAll();
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });

    // unstaged правка checked-источника + staged новый + untracked новый.
    writeProjFile("src/a.ts", "export const A = 2;\n");
    writeProjFile("src/staged.ts", "export const S = 2;\n");
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    execFileSync("git", ["add", "src/staged.ts"], { cwd: projDir, stdio: "ignore" });
    writeProjFile("src/untracked.ts", "export const X = 1;\n");

    const r = await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir });
    expect(r.repo.dirty.unstaged).toContain("src/a.ts");
    expect(r.repo.dirty.staged).toContain("src/staged.ts");
    expect(r.repo.dirty.untracked).toContain("src/untracked.ts");
    expect(r.sources[0]?.git_state).toBe(" M");
    expect(r.sources[0]?.status).toBe("changed");
    expect(r.repo.head_at_check).toMatch(/^[0-9a-f]{40}$/);
    // Явная граница: HEAD — наблюдение, а не доказательство неизменности.
    expect(r.summary.limitations.join(" ")).toContain("не доказательство неизменности working tree");
  });

  it("rename: старый путь missing, rename виден в dirty.renamed", async () => {
    gitInit();
    nodeWithRef("d1", ["src/old.ts"]);
    writeProjFile("src/old.ts", "export const O = 1;\n");
    gitCommitAll();
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    execFileSync("git", ["mv", "src/old.ts", "src/renamed.ts"], { cwd: projDir, stdio: "ignore" });

    const r = await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir });
    expect(r.sources[0]?.status).toBe("missing");
    expect(r.repo.dirty.renamed.join(" ")).toContain("src/old.ts");
    expect(r.records[0]?.state).toBe("stale_input");
  });

  it("перемещение git tag: sha коммита разошёлся — changed", async () => {
    gitInit();
    writeProjFile("src/a.ts", "export const A = 1;\n");
    gitCommitAll();
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    execFileSync("git", ["tag", "v1"], { cwd: projDir, stdio: "ignore" });
    nodeWithRef("d1", ["git:tag:v1"]);
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir, repo: projDir });

    writeProjFile("src/a.ts", "export const A = 2;\n");
    execFileSync("git", ["add", "."], { cwd: projDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "second"], { cwd: projDir, stdio: "ignore" });
    execFileSync("git", ["tag", "-f", "v1"], { cwd: projDir, stdio: "ignore" });

    const r = await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir });
    expect(r.sources[0]?.kind).toBe("git_ref");
    expect(r.sources[0]?.status).toBe("changed");
    expect(r.records[0]?.state).toBe("stale_input");
  });

  it("A04: смешанные repo pin квалифицируются отдельно даже при одинаковых байтах", async () => {
    const repoB = path.join(tmpDir, "repo-b");
    fs.mkdirSync(path.join(repoB, "src"), { recursive: true });
    writeProjFile("src/shared.ts", "export const S = 1;\n");
    fs.writeFileSync(path.join(repoB, "src", "shared.ts"), "export const S = 1;\n", "utf8");
    nodeWithRef("repo-a", ["src/shared.ts"]);
    nodeWithRef("repo-b", ["src/shared.ts"]);
    await checkArtifacts(db, { node_ids: ["repo-a"], cwd: projDir });
    await checkArtifacts(db, { node_ids: ["repo-b"], cwd: repoB });

    for (const [root, own, foreign] of [[projDir, "repo-a", "repo-b"], [repoB, "repo-b", "repo-a"]]) {
      const r = await checkFreshness(db, { sources: ["src/shared.ts"], repo_root: root });
      expect(r.sources[0]?.status).toBe("unchanged");
      expect(r.records.find((x) => x.id === own)?.state).toBe("fresh");
      const other = r.records.find((x) => x.id === foreign);
      expect(other?.state).toBe("unknown");
      expect(other?.checked_sources[0]?.status).toBe("other_repo");
      expect(other?.reasons.join(" ")).toContain("не одна опора");
    }
  });

  it("два репозитория с одинаковым путём: other_repo, сравнение байтов не делается", async () => {
    const repoB = path.join(tmpDir, "repo-b");
    fs.mkdirSync(path.join(repoB, "src"), { recursive: true });
    nodeWithRef("d1", ["src/shared.ts"]);
    writeProjFile("src/shared.ts", "export const S = 'A';\n");
    fs.writeFileSync(path.join(repoB, "src", "shared.ts"), "export const S = 'B';\n", "utf8");
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });

    const r = await checkFreshness(db, { node_ids: ["d1"], repo_root: repoB });
    expect(r.sources[0]?.status).toBe("other_repo");
    expect(r.sources[0]?.note).toContain("другой worktree");
    expect(r.records[0]?.state).toBe("unknown");
    expect(r.records[0]?.reasons.join(" ")).toContain("не одна опора");
    // Текущее наблюдение другого worktree не подменяет ожидаемую версию записи.
    expect(r.expected_versions.find((v) => normalizeSourceKey(v.source) === "src/shared.ts")).toBeDefined();
  });
});

describe("P2.1: доказательство по содержимому", () => {
  it("одинаковые mtime/size при иных bytes: changed (mtime не доказательство)", async () => {
    nodeWithRef("d1", ["src/a.ts"]);
    const content1 = "export const A = 111;\n";
    writeProjFile("src/a.ts", content1);
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });
    const stat1 = fs.statSync(path.join(projDir, "src/a.ts"));

    // Равный размер, другие байты; mtime откатываем к прежнему.
    const content2 = "export const A = 222;\n";
    expect(Buffer.byteLength(content1)).toBe(Buffer.byteLength(content2));
    writeProjFile("src/a.ts", content2);
    fs.utimesSync(path.join(projDir, "src/a.ts"), stat1.atime, stat1.mtime);
    const stat2 = fs.statSync(path.join(projDir, "src/a.ts"));
    expect(stat2.size).toBe(stat1.size);
    // mtime восстановлен (utimes даёт погрешность округления ~1 мс)
    expect(Math.abs(stat2.mtimeMs - stat1.mtimeMs)).toBeLessThan(2);

    const r = await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir });
    expect(r.sources[0]?.status).toBe("changed");
  });

  it("дедуп: два refs одного физического файла (с локатором и без) хешируются один раз", async () => {
    nodeWithRef("d1", ["src/a.ts"]);
    nodeWithRef("d2", ["src/a.ts:1-10"], "fact");
    writeProjFile("src/a.ts", "export const A = 1;\n");
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });

    const r = await checkFreshness(db, { node_ids: ["d1", "d2"], repo_root: projDir });
    // Один физический источник — один source check (дедуп по ключу пути).
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]?.status).toBe("unchanged");
    // Обе записи квалифицированы, но наблюдение d1 не подтверждает d2.
    expect(r.records.map((x) => x.id).sort()).toEqual(["d1", "d2"]);
    expect(r.records.find((x) => x.id === "d1")?.state).toBe("fresh");
    expect(r.records.find((x) => x.id === "d2")?.state).toBe("unknown");
    // expected_versions не дублируют физический источник.
    expect(r.expected_versions).toHaveLength(1);
  });
});

describe("P2.3: границы проверки", () => {
  it("проверка только читает: состав таблиц БД не меняется, снимки не пишутся", async () => {
    nodeWithRef("d1", ["src/a.ts"]);
    writeProjFile("src/a.ts", "export const A = 1;\n");
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });
    writeProjFile("src/a.ts", "export const A = 2;\n");

    const before = tableCounts();
    await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir });
    const after = tableCounts();
    expect(after).toEqual(before);
  });

  it("изменение источника в середине проверки (детерминированная инъекция): unstable, записи unknown, снимок не объявляется", async () => {
    nodeWithRef("d1", ["src/a.ts"]);
    writeProjFile("src/a.ts", "export const A = 1;\n");
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });

    let injected = false;
    const r = await checkFreshness(db, {
      node_ids: ["d1"],
      repo_root: projDir,
      fault_injection: (phase) => {
        expect(phase).toBe("after_first_pass");
        if (!injected) {
          injected = true;
          writeProjFile("src/a.ts", "export const A = 999;\n");
        }
      },
    });
    expect(injected).toBe(true);
    expect(r.sources[0]?.status).toBe("unstable");
    expect(r.sources[0]?.note).toContain("стабильный снимок не объявляется");
    expect(r.records[0]?.state).toBe("unknown");
    // Нестабильное наблюдение не годится как ожидаемая версия.
    expect(r.expected_versions).toHaveLength(0);
  });

  it("пустой вызов без целей — явная ошибка (адресная проверка, не обход графа)", async () => {
    await expect(checkFreshness(db, { repo_root: projDir })).rejects.toThrow(/адресная/);
  });

  it("невалидный бюджет — явная ошибка до всякой работы", async () => {
    await expect(
      checkFreshness(db, { node_ids: ["x"], max_files: 0, repo_root: projDir })
    ).rejects.toThrow(/max_files/);
  });
});

describe("P2.2: символьная ступень (пилот adapter)", () => {
  function writeStub(idx: object, version = "1.0.0"): string {
    const scriptsDir = path.join(projDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptsDir, "graph-tool.js"),
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const kv = {};",
        "for (const a of process.argv.slice(2)) { const i = a.indexOf('='); if (i > 0) kv[a.slice(0, i)] = a.slice(i + 1); }",
        "const idxPath = process.env.STUB_INDEX || path.join(process.cwd(), 'stub-index.json');",
        "const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));",
        "if (kv.op === 'info') { console.log(JSON.stringify({ projectType: 'ts' })); }",
        "else if (kv.op === 'symbol') {",
        "  const defs = (idx.symbols[kv.name] || []).filter(d => !kv.in || d.owner === kv.in);",
        "  console.log(JSON.stringify({ name: kv.name, definedIn: defs }));",
        "} else if (kv.op === 'rdeps') {",
        "  const r = Object.prototype.hasOwnProperty.call(idx, 'rdepsRaw') ? idx.rdepsRaw : Object.assign({ file: kv.file, scope: { scanRoot: 'src' }, completeness: { complete: true } }, idx.rdeps[kv.file] || { importedBy: [], importedByTotal: 0 });",
        "  console.log(JSON.stringify(r));",
        "} else { console.log(JSON.stringify({ error: 'unknown op' })); }",
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(path.join(tmpDir, "stub-index.json"), JSON.stringify(idx), "utf8");
    // stub читает stub-index.json из cwd вызова (repo_root); для тестов с
    // другим набором данных индекс перезаписывается в projDir ниже по месту.
    fs.writeFileSync(path.join(projDir, "stub-index.json"), JSON.stringify(idx), "utf8");
    fs.writeFileSync(path.join(projDir, "VERSION"), `${version}\n`, "utf8");
    return scriptsDir;
  }

  it("capability-детект и версия adapter едут в отчёт", async () => {
    writeStub({ symbols: {}, rdeps: {} }, "9.9.9-test");
    nodeWithRef("d1", ["src/a.ts"]);
    writeProjFile("src/a.ts", "export const A = 1;\n");

    const r = await checkFreshness(db, {
      node_ids: ["d1"],
      repo_root: projDir,
      adapter: { graph_tool: path.join(projDir, "scripts") },
    });
    expect(r.adapter.configured).toBe(true);
    expect(r.adapter.available).toBe(true);
    expect(r.adapter.mode).toBe("symbol");
    expect(r.adapter.version).toBe("9.9.9-test");
    expect(r.adapter.static_scope).toBe("ts");
  });

  it("unique: символ разрешён в актуальный файл/диапазон; номера строк — не идентичность", async () => {
    writeStub({
      symbols: { hashThing: [{ file: "src/thing.ts", kind: "function", line: 30, startLine: 30, endLine: 50 }] },
      rdeps: {},
    });
    nodeWithRef("d1", ["src/thing.ts:10-20"]);
    writeProjFile("src/thing.ts", "export function hashThing() {}\n");

    const r = await checkFreshness(db, {
      node_ids: ["d1"],
      repo_root: projDir,
      symbols: [{ name: "hashThing" }],
      adapter: { graph_tool: path.join(projDir, "scripts") },
    });
    const sym = r.symbols[0];
    expect(sym?.status).toBe("unique");
    expect(sym?.candidates[0]?.file).toBe("src/thing.ts");
    expect(sym?.candidates[0]?.start_line).toBe(30);
    // Записанный локатор 10-20 разошёлся с текущим разрешением 30-50.
    expect(sym?.locator_moved).toBe(true);
    expect(sym?.matched_locators).toHaveLength(1);
    expect(sym?.matched_locators[0]?.range).toBe("10-20");
    expect(sym?.note).toContain("не идентичность");
  });

  it("файл не менялся — символ актуален по содержимому, диапазон не двигался", async () => {
    writeStub({
      symbols: { hashThing: [{ file: "src/thing.ts", kind: "function", line: 1, startLine: 1, endLine: 1 }] },
      rdeps: {},
    });
    nodeWithRef("d1", ["src/thing.ts:1-1"]);
    writeProjFile("src/thing.ts", "export function hashThing() {}\n");
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });

    const r = await checkFreshness(db, {
      node_ids: ["d1"],
      repo_root: projDir,
      symbols: [{ name: "hashThing" }],
      adapter: { graph_tool: path.join(projDir, "scripts") },
    });
    expect(r.symbols[0]?.status).toBe("unique");
    expect(r.symbols[0]?.locator_moved).toBe(false);
    expect(r.symbols[0]?.note).toContain("не изменились");
  });

  it("ambiguous/missing требуют чтения: выбор первого совпадения запрещён", async () => {
    writeStub({
      symbols: {
        make: [
          { file: "src/a.ts", kind: "function", line: 1 },
          { file: "src/b.ts", kind: "function", line: 5 },
        ],
      },
      rdeps: {},
    });
    writeProjFile("src/a.ts", "export function make() {}\n");
    writeProjFile("src/b.ts", "export function make() {}\n");

    const r = await checkFreshness(db, {
      sources: ["src/a.ts"],
      repo_root: projDir,
      symbols: [{ name: "make" }, { name: "ghost" }, { name: "make", file: "src/b.ts" }],
      adapter: { graph_tool: path.join(projDir, "scripts") },
    });
    expect(r.symbols[0]?.status).toBe("ambiguous");
    expect(r.symbols[0]?.candidates).toHaveLength(2);
    expect(r.symbols[0]?.note).toContain("выбор первого совпадения запрещён");
    expect(r.symbols[1]?.status).toBe("missing");
    expect(r.symbols[1]?.note).toContain("требуется чтение");
    // Локатор с file снимает неоднозначность — данные для проверки однозначности.
    expect(r.symbols[2]?.status).toBe("unique");
    expect(r.symbols[2]?.candidates[0]?.file).toBe("src/b.ts");
  });

  it.each([
    { label: "нет определения", files: [], locatorFile: "src/target.ts", status: "missing", expectedFiles: [] },
    { label: "единственный кандидат в другом файле", files: ["src/other.ts"], locatorFile: "src/target.ts", status: "missing", expectedFiles: [] },
    { label: "один из нескольких в заданном файле", files: ["src/other.ts", "src/target.ts"], locatorFile: "src/target.ts", status: "unique", expectedFiles: ["src/target.ts"] },
    { label: "несколько кандидатов вне заданного файла", files: ["src/other.ts", "src/another.ts"], locatorFile: "src/target.ts", status: "missing", expectedFiles: [] },
    { label: "неоднозначность только в заданном файле", files: ["src/other.ts", "src/target.ts", "src/target.ts"], locatorFile: "src/target.ts", status: "ambiguous", expectedFiles: ["src/target.ts", "src/target.ts"] },
    { label: "разделители пути эквивалентны", files: ["src/target.ts"], locatorFile: "src\\target.ts", status: "unique", expectedFiles: ["src/target.ts"] },
    {
      label: "регистр пути зависит от платформы",
      files: ["src/Target.ts", "src/other.ts"],
      locatorFile: "src/target.ts",
      status: process.platform === "win32" ? "unique" : "missing",
      expectedFiles: process.platform === "win32" ? ["src/Target.ts"] : [],
    },
  ])("A10: $label — adapter и freshness соблюдают locator.file", async ({ files, locatorFile, status, expectedFiles }) => {
    const scriptsDir = writeStub({
      symbols: { make: files.map((file) => ({ file, kind: "function", line: 1, startLine: 1, endLine: 1 })) },
      rdeps: {},
    });
    writeProjFile("src/target.ts", "export function make() {}\n");
    const locator = { name: "make", file: locatorFile };
    const cfg = resolveAdapterConfig({ graph_tool: scriptsDir }, projDir)!;
    const outcome = await adapterResolveSymbol(cfg, locator);
    const report = await checkFreshness(db, {
      sources: ["src/target.ts"],
      repo_root: projDir,
      symbols: [locator],
      adapter: { graph_tool: scriptsDir },
    });
    expect(outcome.status).toBe(status);
    const candidates = outcome.status === "unique" ? [outcome.candidate] : outcome.status === "ambiguous" ? outcome.candidates : [];
    expect(candidates.map((candidate) => candidate.file)).toEqual(expectedFiles);
    expect(report.symbols[0]?.status).toBe(status);
    expect(report.symbols[0]?.candidates.map((candidate) => candidate.file)).toEqual(expectedFiles);
    if (status === "missing") {
      expect(report.symbols[0]?.matched_locators).toEqual([]);
      expect(report.symbols[0]?.locator_moved).toBe(false);
      expect(report.symbols[0]?.note).toContain("требуется чтение");
    }
  });

  it("недоступный adapter — ЯВНЫЙ фолбэк файлового уровня, не молча", async () => {
    // Несуществующий скрипт: spawn завершится ошибкой.
    writeProjFile("src/a.ts", "export const A = 1;\n");
    const r = await checkFreshness(db, {
      sources: ["src/a.ts"],
      repo_root: projDir,
      symbols: [{ name: "foo" }],
      adapter: { graph_tool: path.join(projDir, "missing", "graph-tool.js") },
    });
    expect(r.adapter.configured).toBe(true);
    expect(r.adapter.available).toBe(false);
    expect(r.adapter.mode).toBe("file");
    expect(r.sources[0]?.status).toBe("unobserved"); // файловый режим работает
    expect(r.symbols[0]?.status).toBe("adapter_error");
    expect(r.symbols[0]?.note).toContain("файловая проверка");
    expect(r.summary.limitations.join(" ")).toContain("фолбэк");
  });

  it("symbols без конфигурации adapter — явное ограничение", async () => {
    const r = await checkFreshness(db, {
      sources: ["src/a.ts"],
      repo_root: projDir,
      symbols: [{ name: "foo" }],
    });
    expect(r.adapter.configured).toBe(false);
    expect(r.symbols[0]?.status).toBe("adapter_error");
    expect(r.symbols[0]?.note).toContain("не сконфигурирован");
  });

  it.each([
    { label: "пустой объект", response: {} },
    { label: "importedBy не массив", response: { importedBy: "x" } },
    { label: "неполная форма с complete не boolean", response: { importedBy: [], completeness: { complete: "yes" } } },
    { label: "нет importedByTotal", response: { importedBy: [], scope: { scanRoot: "src" }, completeness: { complete: true } } },
    { label: "importedByTotal не число", response: { importedBy: [], importedByTotal: "0", scope: { scanRoot: "src" }, completeness: { complete: true } } },
    { label: "нет scope", response: { importedBy: [], importedByTotal: 0, completeness: { complete: true } } },
    { label: "scope.scanRoot не строка", response: { importedBy: [], importedByTotal: 0, scope: { scanRoot: 123 }, completeness: { complete: true } } },
    { label: "нет completeness", response: { importedBy: [], importedByTotal: 0, scope: { scanRoot: "src" } } },
    { label: "нет completeness.complete", response: { importedBy: [], importedByTotal: 0, scope: { scanRoot: "src" }, completeness: {} } },
    { label: "completeness.complete не boolean", response: { importedBy: [], importedByTotal: 0, scope: { scanRoot: "src" }, completeness: { complete: "yes" } } },
    { label: "null вместо ответа", response: null },
    { label: "массив вместо ответа", response: [] },
  ])("A11: $label — не доказательство пустого полного графа", async ({ response }) => {
    const scriptsDir = writeStub({ symbols: {}, rdeps: {}, rdepsRaw: response });
    nodeWithRef("callee", ["src/callee.ts"], "fact");
    writeProjFile("src/callee.ts", "export const CALLEE = 1;\n");
    await checkArtifacts(db, { node_ids: ["callee"], cwd: projDir });
    writeProjFile("src/callee.ts", "export const CALLEE = 2;\n");
    const cfg = resolveAdapterConfig({ graph_tool: scriptsDir }, projDir)!;
    const outcome = await adapterRdepsOfFile(cfg, "src/callee.ts");
    const report = await checkFreshness(db, {
      sources: ["src/callee.ts"],
      with_dependencies: true,
      adapter: { graph_tool: scriptsDir },
      repo_root: projDir,
    });
    expect(outcome.complete).toBe(false);
    expect(outcome.error).toEqual(expect.any(String));
    expect(outcome.error).not.toBe("");
    expect(outcome.dependents).toEqual([]);
    expect(outcome.total).toBeNull();
    expect(outcome.scan_root).toBeNull();
    expect(report.sources[0]?.status).toBe("changed");
    expect(report.dependencies).toEqual([]);
    expect(report.summary.limitations.join(" ")).toContain("ошибка adapter");
    expect(report.summary.limitations.join(" ")).toContain("это не «зависимостей нет»");
  });

  it.each([
    { label: "валидный пустой граф", importedBy: [], total: 0, declaredComplete: true, complete: true },
    { label: "валидный непустой граф", importedBy: [{ file: "src/caller.ts" }], total: 1, declaredComplete: true, complete: true },
    { label: "объявленная неполнота", importedBy: [], total: 0, declaredComplete: false, complete: false },
    { label: "усечённая выдача", importedBy: [{ file: "src/caller.ts" }], total: 7, declaredComplete: true, complete: false },
  ])("A11: $label — форма и статическая полнота различаются", async ({ importedBy, total, declaredComplete, complete }) => {
    const scriptsDir = writeStub({
      symbols: {},
      rdeps: {},
      rdepsRaw: { importedBy, importedByTotal: total, scope: { scanRoot: "src" }, completeness: { complete: declaredComplete } },
    });
    const cfg = resolveAdapterConfig({ graph_tool: scriptsDir }, projDir)!;
    const outcome = await adapterRdepsOfFile(cfg, "src/callee.ts");
    expect(outcome).toEqual({
      dependents: importedBy.map((entry) => entry.file),
      total,
      complete,
      scan_root: "src",
      error: null,
    });
  });

  it("неполный import-граф (importedByTotal > выданных): префикс не весь граф", async () => {
    const scriptsDir = path.join(projDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptsDir, "graph-tool.js"),
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const kv = {};",
        "for (const a of process.argv.slice(2)) { const i = a.indexOf('='); if (i > 0) kv[a.slice(0, i)] = a.slice(i + 1); }",
        "const idx = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'stub-index.json'), 'utf8'));",
        "if (kv.op === 'info') { console.log(JSON.stringify({ projectType: 'ts' })); }",
        "else if (kv.op === 'rdeps') {",
        "  const r = idx.rdeps[kv.file] || { importedBy: [], importedByTotal: 0 };",
        "  console.log(JSON.stringify(Object.assign({ file: kv.file, scope: { scanRoot: 'src' }, completeness: { complete: true } }, r)));",
        "} else { console.log(JSON.stringify({ error: 'x' })); }",
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(projDir, "stub-index.json"),
      JSON.stringify({
        rdeps: {
          "src/callee.ts": { importedBy: [{ file: "src/caller.ts", kind: "file", level: 1 }], importedByTotal: 7 },
        },
      }),
      "utf8"
    );
    nodeWithRef("d1", ["src/caller.ts"]);
    nodeWithRef("f-callee", ["src/callee.ts"], "fact");
    writeProjFile("src/callee.ts", "export function callee() {}\n");
    writeProjFile("src/caller.ts", "import { callee } from './callee.js';\n");
    await checkArtifacts(db, { node_ids: ["d1", "f-callee"], cwd: projDir });
    writeProjFile("src/callee.ts", "export function callee(x) {}\n");

    const r = await checkFreshness(db, {
      sources: ["src/callee.ts"],
      with_dependencies: true,
      adapter: { graph_tool: scriptsDir },
      repo_root: projDir,
    });
    expect(r.dependencies?.[0]?.complete).toBe(false);
    expect(r.summary.limitations.join(" ")).toContain("неполон");
    expect(r.summary.limitations.join(" ")).toContain("префикс не весь граф");
  });

  it("цикл A→B→A в import-графе завершается; max_deps усечение помечается", async () => {
    const scriptsDir = path.join(projDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptsDir, "graph-tool.js"),
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const kv = {};",
        "for (const a of process.argv.slice(2)) { const i = a.indexOf('='); if (i > 0) kv[a.slice(0, i)] = a.slice(i + 1); }",
        "const idx = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'stub-index.json'), 'utf8'));",
        "if (kv.op === 'info') { console.log(JSON.stringify({ projectType: 'ts' })); }",
        "else if (kv.op === 'rdeps') {",
        "  const r = idx.rdeps[kv.file] || { importedBy: [], importedByTotal: 0 };",
        "  console.log(JSON.stringify(Object.assign({ file: kv.file, scope: { scanRoot: 'src' }, completeness: { complete: true } }, r)));",
        "} else { console.log(JSON.stringify({ error: 'x' })); }",
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(projDir, "stub-index.json"),
      JSON.stringify({
        rdeps: {
          "src/a.ts": {
            importedBy: [
              { file: "src/b.ts", kind: "file", level: 1 },
              { file: "src/a.ts", kind: "file", level: 1 }, // самоцикл
            ],
            importedByTotal: 2,
          },
        },
      }),
      "utf8"
    );
    writeProjFile("src/a.ts", "import { b } from './b.js';\nexport function a() {}\n");
    writeProjFile("src/b.ts", "import { a } from './a.js';\nexport function b() {}\n");
    nodeWithRef("d1", ["src/a.ts"]);
    await checkArtifacts(db, { node_ids: ["d1"], cwd: projDir });
    writeProjFile("src/a.ts", "import { b } from './b.js';\nexport function a(x) {}\n");

    const r1 = await checkFreshness(db, {
      sources: ["src/a.ts"],
      with_dependencies: true,
      adapter: { graph_tool: scriptsDir },
      repo_root: projDir,
    });
    expect(r1.dependencies?.[0]?.dependents.sort()).toEqual(["src/a.ts", "src/b.ts"]);

    const r2 = await checkFreshness(db, {
      sources: ["src/a.ts"],
      with_dependencies: true,
      max_deps: 1,
      adapter: { graph_tool: scriptsDir },
      repo_root: projDir,
    });
    expect(r2.dependencies?.[0]?.dependents).toHaveLength(1);
    expect(r2.summary.truncated_by).toBe("max_deps");
    expect(r2.summary.limitations.join(" ")).toContain("max_deps");
  });

  it("изменение версии adapter видно в отчёте; версия входит в квалификацию наблюдения", async () => {
    writeStub({ symbols: {}, rdeps: {} }, "1.0.0");
    nodeWithRef("d1", ["src/a.ts"]);
    writeProjFile("src/a.ts", "export const A = 1;\n");
    const cfg = { graph_tool: path.join(projDir, "scripts") };
    const r1 = await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir, adapter: cfg });
    expect(r1.adapter.version).toBe("1.0.0");
    writeStub({ symbols: {}, rdeps: {} }, "2.0.0");
    const r2 = await checkFreshness(db, { node_ids: ["d1"], repo_root: projDir, adapter: cfg });
    expect(r2.adapter.version).toBe("2.0.0");
    // Вердикт по неизменным байтам не меняется от смены версии adapter.
    expect(r2.sources[0]?.status).toBe(r1.sources[0]?.status);
  });

  it("env MEGAMEMORY_CODE_ADAPTER — альтернативная конфиг-точка", async () => {
    writeStub({ symbols: {}, rdeps: {} }, "1.0.0");
    process.env.MEGAMEMORY_CODE_ADAPTER = path.join(projDir, "scripts");
    try {
      const r = await checkFreshness(db, { sources: ["src/a.ts"], repo_root: projDir });
      expect(r.adapter.configured).toBe(true);
      expect(r.adapter.available).toBe(true);
    } finally {
      delete process.env.MEGAMEMORY_CODE_ADAPTER;
    }
  });
});
