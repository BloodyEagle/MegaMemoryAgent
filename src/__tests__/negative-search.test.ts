import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { trailSaveWithPassport, understand } from "../tools.js";
import { qualifyReuse } from "../passport.js";
import type { PassportPayload } from "../types.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

// P4.2 (план 20+21 v3 §13): ограниченные отрицательные результаты.
//
// Контракт:
// - «Не найдено в обследованной области» сохраняется ТОЛЬКО вместе с:
//   точным запросом и режимом инструмента; scope, расширениями, исключениями,
//   включением тестов; версией инструмента/настроек; manifest состава
//   обследованных файлов и их версий (sha256); доказательством завершённого
//   поиска без усечения/ошибки.
// - НЕ новый kind узла (второе изменение публичного контракта не делается):
//   семейство паспортов (task_type='negative_search') через существующий
//   trail/timeline-механизм P1, манифест в теле.
// - Инвалидация reuse: новый файл в scope, изменённый scope/запрос, неполный
//   результат. Ошибка, пустой stdout, truncated-выдача НЕ являются no-match —
//   запись такой «отрицалки» запрещена (явные статусы).
// - Существующее refuted-знание не дублируется: negative-паспорт не создаёт
//   узлов вообще (проверка механики дедупликации паспортов — по (запрос,
//   инструмент, опции, состав области)).

let tmpDir: string;
let projDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-p4neg-"));
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoosePassport = Record<string, any>;

const QUERY = "retry-budget для исходящих HTTP";

async function saveNegative(
  opts: {
    scope?: string[];
    query?: string;
    tool?: string;
    options?: Record<string, string>;
    truncated?: boolean;
    errored?: boolean;
    negative?: boolean;
    forceDuplicate?: boolean;
    name?: string;
  } = {}
): Promise<PassportPayload & { trail_id: string }> {
  const scope = opts.scope ?? ["src/net/client.ts", "src/net/retry.ts"];
  for (const rel of scope) writeProjFile(rel, `// ${rel}\nexport const marker = "${rel}";\n`);
  const passport: LoosePassport = {
    task_type: "negative_search",
    goal: "Проверить, разбирали ли уже retry-budget в сетевом клиенте",
    scope_files: scope,
    tools: { grep: "2.5.1" },
    ...(opts.negative === false
      ? {}
      : {
          negative: {
            query: opts.query ?? QUERY,
            tool: opts.tool ?? "understand mode=compact top_k=10",
            options: opts.options ?? { include_tests: "false", exclude: "node_modules" },
            ...(opts.truncated ? { truncated: true } : {}),
            ...(opts.errored ? { errored: true } : {}),
            ...(opts.forceDuplicate ? { force_duplicate: true } : {}),
          },
        }),
  };
  const result = await trailSaveWithPassport(db, {
    node_ids: ["anchor-node"],
    summary: `Поиск «${passport.negative?.query ?? "?"}» в области ${scope.join(", ")} завершился без совпадений.`,
    name: opts.name ?? "negative-search",
    repo_root: projDir,
    passport: passport as Parameters<typeof trailSaveWithPassport>[1]["passport"],
  });
  return { ...result.passport, trail_id: result.id };
}

describe("P4.2 negative_search: запись манифеста", () => {
  beforeEach(() => {
    db.insertNode({
      id: "anchor-node",
      name: "Net client",
      kind: "module",
      summary: "Сетевой клиент и ретраи.",
      file_refs: ["src/net/client.ts"],
    });
  });

  it("сохраняет negative-паспорт: манифест (запрос, инструмент/режим, опции, завершённость) + manifest области с sha256 в теле; формат 1, нового kind узла нет", async () => {
    const saved = await saveNegative();
    expect(saved.passport_format).toBe(1);
    expect(saved.task_type).toBe("negative_search");
    expect(saved.negative).toMatchObject({
      query: QUERY,
      tool: "understand mode=compact top_k=10",
      completed: true,
    });
    expect(saved.negative?.options?.include_tests).toBe("false");
    // Область — существующий scope паспорта с хешами версий файлов.
    expect(saved.scope.files).toHaveLength(2);
    expect(saved.scope.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.scope.truncated).toBe(false);
    // НЕ новый kind узла: ни один узел не создан negative-записью.
    const nodes = db.execSqlAll("SELECT id FROM nodes") as Array<{ id: string }>;
    expect(nodes.map((n) => n.id)).toEqual(["anchor-node"]);
  });

  it("валидация ДО записи: negative_search без манифеста — ошибка", async () => {
    await expect(saveNegative({ negative: false })).rejects.toThrow(/negative|манифест/i);
  });

  it("ошибка и усечение НЕ являются no-match: truncated/errored поиск не сохраняется как отрицательный результат", async () => {
    await expect(saveNegative({ truncated: true })).rejects.toThrow(/truncat|усеч/i);
    await expect(saveNegative({ errored: true })).rejects.toThrow(/ошибк|error/i);
    const trails = db.execSqlAll("SELECT COUNT(*) AS n FROM trails") as Array<{ n: number }>;
    expect(trails[0].n).toBe(0);
  });

  it("дедупликация: тот же запрос/инструмент/опции/состав области — явный отказ с указанием существующего trail_id", async () => {
    const first = await saveNegative();
    await expect(saveNegative()).rejects.toMatchObject({
      message: expect.stringContaining(first.trail_id),
    });
    await expect(saveNegative()).rejects.toThrow(/дубликат|duplicate|уже/i);
  });

  it("другая область или другой запрос — не дубликат: новая запись законна", async () => {
    await saveNegative();
    const other = await saveNegative({ scope: ["src/net/other.ts"] });
    expect(other.trail_id).toBeTruthy();
    const otherQuery = await saveNegative({ name: "negative-2", query: "другой запрос", forceDuplicate: false });
    expect(otherQuery.trail_id).toBeTruthy();
  });

  it("повторная проверка той же области — только явным force_duplicate (новая дата проверки)", async () => {
    await saveNegative();
    const again = await saveNegative({ forceDuplicate: true, name: "negative-again" });
    expect(again.trail_id).toBeTruthy();
  });
});

describe("P4.2 negative_search: квалификация reuse и инвалидация", () => {
  beforeEach(() => {
    db.insertNode({
      id: "anchor-node",
      name: "Net client",
      kind: "module",
      summary: "Сетевой клиент и ретраи.",
      file_refs: ["src/net/client.ts"],
    });
  });

  it("тот же запрос/инструмент/область с неизменными файлами → reusable: reuse означает «не найдено в обследованной области», не «не существует»", async () => {
    await saveNegative();
    const view = await qualifyReuse(db, {
      task_type: "negative_search",
      files: ["src/net/client.ts", "src/net/retry.ts"],
      repo_root: projDir,
      negative: { query: QUERY, tool: "understand mode=compact top_k=10" },
    });
    const c = view.candidates[0];
    expect(c.qualification).toBe("reusable");
    expect(c.negative).toBeDefined();
    expect(c.negative?.query).toBe(QUERY);
    expect(c.negative?.reuse_meaning).toMatch(/обследован|не найдено/i);
    expect(c.negative?.notes.join(" ")).toMatch(/не существует|ограничен/i);
  });

  it("новый файл в scope → инвалидация: candidate + new_file_in_scope, negative-блок не выдаёт reuse", async () => {
    await saveNegative();
    writeProjFile("src/net/timeout.ts", "// новый файл\n");
    const view = await qualifyReuse(db, {
      task_type: "negative_search",
      files: ["src/net/client.ts", "src/net/retry.ts", "src/net/timeout.ts"],
      repo_root: projDir,
      negative: { query: QUERY },
    });
    const c = view.candidates[0];
    expect(c.qualification).toBe("candidate");
    expect(c.gaps.some((g) => g.kind === "new_file_in_scope" && g.detail.includes("src/net/timeout.ts"))).toBe(true);
    expect(c.negative).toBeUndefined();
  });

  it("изменённый файл области → stale_input: reuse отрицательного результата запрещён", async () => {
    await saveNegative();
    writeProjFile("src/net/retry.ts", "// переписан\nexport const marker = 2;\n");
    const view = await qualifyReuse(db, {
      task_type: "negative_search",
      files: ["src/net/client.ts", "src/net/retry.ts"],
      repo_root: projDir,
      negative: { query: QUERY },
    });
    const c = view.candidates[0];
    expect(c.qualification).toBe("stale_input");
    expect(c.negative).toBeUndefined();
  });

  it("изменённый запрос → query_mismatch: другой запрос не переиспользует чужой negative", async () => {
    await saveNegative();
    const view = await qualifyReuse(db, {
      task_type: "negative_search",
      files: ["src/net/client.ts", "src/net/retry.ts"],
      repo_root: projDir,
      negative: { query: "другой запрос" },
    });
    const c = view.candidates[0];
    expect(c.qualification).not.toBe("reusable");
    expect(c.gaps.some((g) => g.kind === "query_mismatch")).toBe(true);
    expect(c.negative).toBeUndefined();
  });

  it("изменённые опции (включение тестов) → инвалидация reuse", async () => {
    await saveNegative();
    const view = await qualifyReuse(db, {
      task_type: "negative_search",
      files: ["src/net/client.ts", "src/net/retry.ts"],
      repo_root: projDir,
      negative: { query: QUERY, tool: "understand mode=compact top_k=10", options: { include_tests: "true" } },
    });
    const c = view.candidates[0];
    expect(c.qualification).not.toBe("reusable");
    expect(c.gaps.some((g) => g.kind === "options_mismatch")).toBe(true);
  });

  it("understand compact + reuse: negative-блок в секции passport_reuse; ограниченная формулировка", async () => {
    await saveNegative();
    const result = (await understand(db, {
      query: "retry-budget",
      mode: "compact",
      max_tokens: 6000,
      reuse: {
        task_type: "negative_search",
        files: ["src/net/client.ts", "src/net/retry.ts"],
        repo_root: projDir,
        negative: { query: QUERY },
      },
    })) as unknown as {
      passport_reuse?: { candidates: Array<{ qualification: string; negative?: { reuse_meaning: string } }> };
    };
    const cand = result.passport_reuse?.candidates[0];
    expect(cand?.qualification).toBe("reusable");
    expect(cand?.negative?.reuse_meaning).toMatch(/обследован/i);
  });
});
