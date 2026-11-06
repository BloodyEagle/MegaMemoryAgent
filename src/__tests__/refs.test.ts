/**
 * 2.1.13 F2: файловые ссылки с локаторами. Один контракт разбора (src/refs.ts)
 * для check_artifacts и bench: локатор (:12, :12-30, #L12, #L12-L30) снимается
 * перед файловой системой, git-формы не режутся вовсе, Windows не ломается,
 * хеш — по всему файлу.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { checkArtifacts } from "../artifacts.js";
import { parseRef, classifyRef } from "../refs.js";
import { splitRefSuffix } from "../bench.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-refs-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
});

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
  delete process.env.MEGAMEMORY_DB_PATH;
});

function anchor(id: string, refs: string[]): void {
  db.insertNode({ id, name: id, kind: "feature", summary: `узел ${id}`, file_refs: refs });
}

describe("parseRef — пять форм и Windows (тесты 12, 15)", () => {
  it("режет только распознанный конечный локатор", () => {
    expect(parseRef("src/a.ts")).toEqual({ kind: "file", path: "src/a.ts", locator: null, raw: "src/a.ts" });
    expect(parseRef("src/a.ts:12")!.locator).toBe("12");
    expect(parseRef("src/a.ts:12-30")).toEqual({ kind: "file", path: "src/a.ts", locator: "12-30", raw: "src/a.ts:12-30" });
    expect(parseRef("src/a.ts#L12")).toEqual({ kind: "file", path: "src/a.ts", locator: "12", raw: "src/a.ts#L12" });
    expect(parseRef("src/a.ts#L12-L30")).toEqual({ kind: "file", path: "src/a.ts", locator: "12-30", raw: "src/a.ts#L12-L30" });
  });

  it("Windows: буква диска, UNC, двоеточия и # внутри имени не ломаются", () => {
    expect(parseRef("C:\\proj\\a.ts")).toEqual({ kind: "file", path: "C:\\proj\\a.ts", locator: null, raw: "C:\\proj\\a.ts" });
    expect(parseRef("C:\\proj\\a.ts:10")).toEqual({ kind: "file", path: "C:\\proj\\a.ts", locator: "10", raw: "C:\\proj\\a.ts:10" });
    expect(parseRef("\\\\srv\\share\\a.ts").path).toBe("\\\\srv\\share\\a.ts");
    expect(parseRef("\\\\srv\\share\\a.ts").locator).toBeNull();
    // хвост не локатор — строка целая
    expect(parseRef("a:b.ts").path).toBe("a:b.ts");
    expect(parseRef("a:b.ts:9").path).toBe("a:b.ts");
    expect(parseRef("src/a.ts:abc").path).toBe("src/a.ts:abc");
    // # в имени без L-формы не режется; файл с именем #L12 не режется
    expect(parseRef("issue#42").path).toBe("issue#42");
    expect(parseRef("#L12").path).toBe("#L12");
  });

  it("git-формы проверяются до файловой нормализации и не режутся", () => {
    expect(parseRef("git:tag:v2.1.12")).toEqual({ kind: "git", path: "git:tag:v2.1.12", locator: null, raw: "git:tag:v2.1.12" });
    // числовой тег — не путь «git:tag» с локатором «2026»
    expect(parseRef("git:tag:2026").kind).toBe("git");
    expect(parseRef("git:tag:2026").path).toBe("git:tag:2026");
    expect(parseRef("git:commit:abc1234").path).toBe("git:commit:abc1234");
    expect(parseRef("git:branch:main").kind).toBe("git");
    expect(parseRef("HEAD:src/a.ts").kind).toBe("git");
    expect(classifyRef("git:tag:v2.1.12")).toEqual({ kind: "git_ref", scheme: "tag", name: "v2.1.12" });
  });

  it("bench и check_artifacts понимают ссылки одинаково (тест 15)", () => {
    const refs = [
      "src/a.ts",
      "src/a.ts:12",
      "src/a.ts:12-30",
      "src/a.ts#L12",
      "src/a.ts#L12-L30",
      "C:\\proj\\a.ts",
      "C:\\proj\\a.ts:9",
      "a:b.ts",
      "a:b.ts:9",
      "src/a.ts:abc",
      "\\\\srv\\share\\a.ts",
      "git:tag:v1",
      "git:tag:2026",
      "git:commit:abc1234",
      "HEAD:src/a.ts",
      "src/a.ts:12-30-40",
    ];
    for (const ref of refs) {
      const parsed = parseRef(ref);
      const split = splitRefSuffix(ref);
      expect(split.path, ref).toBe(parsed.path);
      expect(split.suffix, ref).toBe(parsed.locator ?? "");
    }
  });
});

describe("check_artifacts с локаторами (тесты 9-11, 14)", () => {
  it("все пять форм находят файл и дают одинаковый sha256 (тест 9)", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "line1\nline2\n");
    anchor("n1", ["a.ts", "a.ts:2", "a.ts:1-2", "a.ts#L2", "a.ts#L1-L2"]);
    const out = await checkArtifacts(db, { node_ids: ["n1"], cwd: tmpDir });
    expect(out.missing).toEqual([]);
    expect(out.changed).toEqual([]);
    expect(out.checked).toBe(5);
    const expected = createHash("sha256").update("line1\nline2\n").digest("hex");
    const rows = db.getNodeArtifacts("n1");
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.kind).toBe("file");
      expect(row.digest).toBe(expected);
    }
  });

  it("изменение файла видно через ссылку с локатором (тест 10)", async () => {
    const file = path.join(tmpDir, "b.ts");
    fs.writeFileSync(file, "v1\n");
    anchor("n2", ["b.ts:1"]);
    const first = await checkArtifacts(db, { node_ids: ["n2"], cwd: tmpDir });
    expect(first.changed).toEqual([]);

    fs.writeFileSync(file, "v2 changed\n");
    const second = await checkArtifacts(db, { node_ids: ["n2"], cwd: tmpDir });
    expect(second.changed).toHaveLength(1);
    expect(second.changed[0].ref).toBe("b.ts:1");
    expect(second.changed[0].old).not.toBe(second.changed[0].new);
  });

  it("удалённый файл → missing (тест 11)", async () => {
    const file = path.join(tmpDir, "c.ts");
    fs.writeFileSync(file, "bye\n");
    anchor("n3", ["c.ts#L1"]);
    await checkArtifacts(db, { node_ids: ["n3"], cwd: tmpDir });
    fs.rmSync(file);
    const second = await checkArtifacts(db, { node_ids: ["n3"], cwd: tmpDir });
    expect(second.missing).toHaveLength(1);
    expect(second.missing[0].ref).toBe("c.ts#L1");
    expect(second.missing[0].kind).toBe("file");
  });

  it("первый check_artifacts после обновления не даёт ложного changed (тест 14)", async () => {
    fs.writeFileSync(path.join(tmpDir, "d.ts"), "fresh\n");
    anchor("n4", ["d.ts:1-1"]);
    const out = await checkArtifacts(db, { node_ids: ["n4"], cwd: tmpDir });
    expect(out.changed).toEqual([]);
    expect(out.missing).toEqual([]);
    expect(out.checked).toBe(1);
  });

  it("абсолютный путь с локатором хешируется (тест 12, файловая часть)", async () => {
    const abs = path.join(tmpDir, "e.ts");
    fs.writeFileSync(abs, "abs\n");
    anchor("n5", [`${abs}:10`]);
    const out = await checkArtifacts(db, { node_ids: ["n5"], cwd: tmpDir });
    expect(out.missing).toEqual([]);
    const row = db.getNodeArtifacts("n5")[0];
    expect(row.digest).toBe(createHash("sha256").update("abs\n").digest("hex"));
  });
});

describe("git-ссылка не режется и проверяется как git (тест 13)", () => {
  it("git:tag:v2.1.12 резолвится в sha коммита", async () => {
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    const git = (args: string): void =>
      execFileSync("git", args.split(" "), { cwd: repo, stdio: "ignore" });
    git("init -b main");
    git("config user.email t@example.com");
    git("config user.name t");
    git("config commit.gpgsign false");
    fs.writeFileSync(path.join(repo, "f.txt"), "tagged\n");
    git("add -A");
    git('commit -m "c1"');
    git("tag v2.1.12");
    const sha = execFileSync("git", ["rev-parse", "HEAD^{commit}"], { cwd: repo })
      .toString()
      .trim();

    const repoDb = new KnowledgeDB(path.join(repo, "knowledge.db"));
    ensureSchema(repoDb);
    repoDb.insertNode({
      id: "g1",
      name: "g1",
      kind: "feature",
      summary: "git-опора",
      file_refs: ["git:tag:v2.1.12"],
    });
    const out = await checkArtifacts(repoDb, { node_ids: ["g1"], repo: repo });
    expect(out.missing).toEqual([]);
    const row = repoDb.getNodeArtifacts("g1")[0];
    expect(row.kind).toBe("git_ref");
    expect(row.ref).toBe("git:tag:v2.1.12"); // не разрезан
    expect(row.digest).toBe(sha);
    await closeAndCleanup(repoDb, repo);
  });
});
