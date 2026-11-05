/**
 * 2.1.12 F2: опора на git-объекты. «Влито в main», «вышел 2.1.11» проверяются
 * тегом/коммитом/веткой: git:tag:<name> / git:commit:<sha> / git:branch:<name>
 * разрешаются локальным git в sha коммита; тег переехал — changed, ref исчез —
 * missing, git-а нет — честная ошибка. Сетевых вызовов нет.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { KnowledgeDB } from "../db.js";
import { createConcept, link } from "../tools.js";
import { provenanceTrace } from "../provenance.js";
import { countStubSupports } from "../stub.js";
import {
  CheckBudget,
  claimDigestOf,
  computeSupportCheck,
  confirmSupports,
  edgeDigestOf,
  statusDigestOf,
} from "../support-baselines.js";
import { checkArtifacts } from "../artifacts.js";
import { ensureSchema } from "../migrate-schema.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

vi.mock("../embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings.js")>();
  return {
    ...actual,
    embed: vi.fn(async () => Buffer.alloc(0)),
    embedForStorage: vi.fn(async () => null),
    vectorSearchEnabled: vi.fn(() => false),
  };
});

let tmpDir: string;
let repo: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-git-refs-"));
  repo = path.join(tmpDir, "repo");
  fs.mkdirSync(repo);
  git("init -b main");
  git("config user.email t@example.com");
  git("config user.name t");
  git("config commit.gpgsign false");
  // база живёт внутри репозитория — дефолтный путь для git:-разрешения
  db = new KnowledgeDB(path.join(repo, "knowledge.db"));
  ensureSchema(db);
});

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
  delete process.env.MEGAMEMORY_DB_PATH;
});

function git(args: string): void {
  execFileSync("git", args.split(" "), { cwd: repo, stdio: "ignore" });
}

/** Коммит текущего дерева, возвращает sha (без shell: ^ в cmd съедается). */
function commit(msg: string): string {
  git("add -A");
  git(`commit -m "${msg}"`);
  return execFileSync("git", ["rev-parse", "HEAD^{commit}"], { cwd: repo }).toString().trim();
}

function anchorNode(id: string, ref: string): void {
  db.insertNode({ id, name: id, kind: "feature", summary: `Проверяем git-опору ${ref}`, file_refs: [ref] });
}

function decisionWithSupport(id: string, supportId: string): void {
  db.insertNode({ id, name: id, kind: "decision", summary: `decision ${id}` });
  link(db, { from: id, to: supportId, relation: "informed_by", description: `why ${supportId}` });
}

function confirmNow(decisionId: string, supportIds: string[]) {
  const decision = db.getNode(decisionId)!;
  const edges = db.getInformedByEdges(decisionId, "ancestry", false);
  return confirmSupports(db, {
    decision_id: decisionId,
    expected_claim_digest: claimDigestOf(decision.summary),
    items: supportIds.map((sid) => {
      const edge = edges.find((e) => e.other_id === sid)!;
      const support = db.getNode(sid)!;
      return {
        support_id: sid,
        expected_claim_digest: claimDigestOf(support.summary),
        expected_status_digest: statusDigestOf(support.status, support.epistemic_status),
        expected_edge_digest: edgeDigestOf(edge.description),
      };
    }),
  });
}

const check = (nodeIds: string[], input: { repo?: string } = {}) =>
  checkArtifacts(db, { node_ids: nodeIds, ...input });

// ---- 9-13: разрешение и вердикты ----

describe("F2: git:-опоры", () => {
  it("9. git:tag: разрешается в sha; повтор — unchanged", async () => {
    const sha = commit("c1");
    git("tag v1.0");
    anchorNode("s", "git:tag:v1.0");

    const first = await check(["s"]);
    expect(first.checked).toBe(1);
    expect(first.changed).toEqual([]);
    expect(first.missing).toEqual([]);
    const row = db.getNodeArtifacts("s")[0];
    expect(row.kind).toBe("git_ref");
    expect(row.digest).toBe(sha);
    // репозиторий закреплён при первом разрешении (дефолт — каталог базы)
    expect(row.repo_path?.toLowerCase()).toBe(repo.toLowerCase());

    const second = await check(["s"]);
    expect(second.changed).toEqual([]);
    expect(db.getNodeArtifacts("s")[0].digest).toBe(sha);
  });

  it("10. тег переехал → changed, в weak_links оба sha", async () => {
    const sha1 = commit("c1");
    git("tag v1.0");
    anchorNode("s", "git:tag:v1.0");
    decisionWithSupport("d", "s");
    await check(["s"]);
    confirmNow("d", ["s"]);

    const sha2 = commit("c2");
    git("tag -f v1.0"); // тег переехал на новый коммит
    const res = await check(["s"]);
    expect(res.changed).toEqual([{ node_id: "s", ref: "git:tag:v1.0", old: sha1, new: sha2 }]);

    const trace = provenanceTrace(db, { node_id: "d" });
    const art = trace.weak_links.find((w) => w.type === "artifact_changed");
    expect(art).toBeDefined();
    expect(art!.note).toContain("git:tag:v1.0");
    // оба sha в предупреждении — 12-символьные превью (контракт дайджестов)
    expect(art!.note).toContain(sha1.slice(0, 12));
    expect(art!.note).toContain(sha2.slice(0, 12));

    const view = computeSupportCheck(db, "d", new CheckBudget(10, 1_000_000))!;
    expect(view.state).toBe("changed");
    expect(view.changed![0].artifact_changed).toBe(true);
    expect(view.artifact_changed_count).toBe(1);
  });

  it("11. несуществующий тег → missing, не падение", async () => {
    anchorNode("s", "git:tag:v9.9.9");

    const res = await check(["s"]);
    expect(res.checked).toBe(1);
    expect(res.missing).toEqual([
      { node_id: "s", ref: "git:tag:v9.9.9", kind: "git_ref", digest: null, missing: true },
    ]);
    expect(res.changed).toEqual([]);
    expect(db.getNodeArtifacts("s")[0].digest).toBeNull();
  });

  it("12. git:commit: с 7 символами разрешается в полный sha", async () => {
    const sha = commit("c1");
    anchorNode("s", `git:commit:${sha.slice(0, 7)}`);

    const res = await check(["s"]);
    expect(res.changed).toEqual([]);
    expect(db.getNodeArtifacts("s")[0].digest).toBe(sha);
  });

  it("13. git:branch: меняется после нового коммита → changed", async () => {
    const sha1 = commit("c1");
    anchorNode("s", "git:branch:main");
    await check(["s"]);
    const first = db.getNodeArtifacts("s")[0];
    expect(first.digest).toBe(sha1);

    const sha2 = commit("c2"); // ветка уехала
    const res = await check(["s"]);
    expect(res.changed).toEqual([{ node_id: "s", ref: "git:branch:main", old: sha1, new: sha2 }]);
    expect(db.getNodeArtifacts("s")[0].digest).toBe(sha2);
  });

  it("13b. repo_path закрепляет репозиторий: повтор из другого места без input.repo", async () => {
    const sha = commit("c1");
    git("tag v1.0");
    anchorNode("s", "git:tag:v1.0");

    // первое разрешение — явный --repo
    await check(["s"], { repo });
    expect(db.getNodeArtifacts("s")[0].repo_path?.toLowerCase()).toBe(repo.toLowerCase());

    // повтор: репозиторий не передан — идёт в закреплённый, ref резолвится
    const outside = path.join(tmpDir, "nowhere");
    fs.mkdirSync(outside);
    const res = await checkArtifacts(db, { node_ids: ["s"], cwd: outside });
    expect(res.changed).toEqual([]);
    expect(db.getNodeArtifacts("s")[0].digest).toBe(sha);
  });

  it("14. git-а нет в системе → честная ошибка, а не тихий unchanged", async () => {
    commit("c1");
    git("tag v1.0");
    anchorNode("s", "git:tag:v1.0");

    const realPath = process.env.PATH;
    process.env.PATH = path.join(tmpDir, "empty-bin");
    try {
      await expect(check(["s"])).rejects.toThrow(/git не найден/);
    } finally {
      process.env.PATH = realPath;
    }
    // после отказа наблюдение не записано: никакого «unchanged»
    expect(db.getNodeArtifacts("s")).toHaveLength(0);
  });

  it("15. якорь git_ref не считается заглушкой", async () => {
    const created = await createConcept(db, {
      name: "merge-pr18",
      kind: "decision",
      summary: "PR #18 влит в main: merge-коммит 6088cf1 сидит в истории и требует проверки тегом",
      evidence: [{ ref: "git:tag:v9.9.9", why: "влитость PR подтверждается тегом релиза" }],
    });
    expect(created.id).toBe("merge-pr18");

    // якорь: имя = ref, id — слаг makeId (двоеточия выпадают)
    const anchor = db
      .execSqlAll("SELECT id FROM nodes WHERE name = 'git:tag:v9.9.9'")
      .map((r) => r.id as string);
    expect(anchor).toHaveLength(1);
    const anchorId = anchor[0];
    const row = db.getNode(anchorId)!;
    expect(row.created_via).toBe("file_ref");
    expect(row.file_refs).toBe(JSON.stringify(["git:tag:v9.9.9"]));
    // якорь с шаблонным саммари — не заглушка: происхождение file_ref
    expect(countStubSupports(db)).toBe(0);

    // несуществующий тег: check по якорю даёт missing, решение остаётся
    // с честным снимком, а не с «всё хорошо»
    const res = await check([anchorId]);
    expect(res.missing).toHaveLength(1);
  });
});
