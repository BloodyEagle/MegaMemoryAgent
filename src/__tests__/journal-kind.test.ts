/**
 * M2 B1 (план 20+21 v3 §7): явный kind `journal` для оперативных записей о
 * состоянии («PR открыт сейчас»). Не доказанность и не замена decision:
 * journal — изменчивое утверждение о состоянии со своей expiry-политикой
 * (§7 B2), историческое событие («релиз опубликован в дату X») от возраста
 * не становится ложным — срок ограничивает полезность в текущем контексте,
 * это политика выдачи, а не авто-refuted.
 *
 * Добавление kind — изменение публичного контракта: сверяются валидация
 * (create/update), отображение (get_concept/understand/export), веб-эксплорер
 * и MCP-описания (§18).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { KnowledgeDB } from "../db.js";
import { createConcept, updateConcept, getConcept, understand } from "../tools.js";
import { exportMarkdown } from "../export.js";
import { NODE_KINDS } from "../types.js";
import { ensureSchema } from "../migrate-schema.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

vi.mock("../embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings.js")>();
  return {
    ...actual,
    embed: vi.fn(async () => Buffer.alloc(0)),
    embeddingText: vi.fn((name: string, kind: string, summary: string) => `${kind}: ${name} — ${summary}`),
    findTopK: vi.fn(),
    embedForStorage: vi.fn(async () => null),
    vectorSearchEnabled: vi.fn(() => false),
    cosineSimilarity: vi.fn(() => 0),
    queryText: vi.fn((q: string) => q),
    isModelLoaded: vi.fn(() => false),
  };
});

let tmpDir: string;
let db: KnowledgeDB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-journal-kind-"));
  db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
  ensureSchema(db);
  process.env.MEGAMEMORY_SEARCH = "fts";
  delete process.env.MEGAMEMORY_EXPIRY_JOURNAL_DAYS;
});

afterEach(async () => {
  delete process.env.MEGAMEMORY_SEARCH;
  delete process.env.MEGAMEMORY_EXPIRY_JOURNAL_DAYS;
  if (db) await closeAndCleanup(db, tmpDir);
});

describe("B1: kind journal — публичный контракт", () => {
  it("enum NODE_KINDS содержит journal (после digest — не первым: next-hints берёт NODE_KINDS[0])", () => {
    expect(NODE_KINDS).toContain("journal");
    expect(NODE_KINDS[0]).not.toBe("journal");
  });

  it("create_concept принимает kind=journal; короткое оперативное саммари — не заглушка", async () => {
    const res = await createConcept(db, {
      name: "pr-34-open",
      kind: "journal",
      summary: "PR #34 открыт, ждёт ревью",
    });
    expect(res.id).toBe("pr-34-open");
    expect(db.getNode("pr-34-open")!.kind).toBe("journal");
  });

  it("update_concept принимает смену вида на journal и правку journal-саммари без отказа-заглушки", async () => {
    await createConcept(db, {
      name: "short-note",
      kind: "feature",
      summary: "Импорт кэширует результат по mtime и инвалидируется сменой tsconfig",
    });
    const res = await updateConcept(db, {
      id: "short-note",
      changes: { kind: "journal", summary: "Миграция схемы не начата" },
    });
    expect(res.message).toContain("Updated");
    expect(db.getNode("short-note")!.kind).toBe("journal");
  });

  it("отображение: get_concept и understand отдают kind=journal как есть", async () => {
    await createConcept(db, {
      name: "pr-35-open",
      kind: "journal",
      summary: "PR #35 открыт и ожидает ревью после рефакторинга экспорта",
    });
    const card = getConcept(db, { id: "pr-35-open" });
    expect(card.kind).toBe("journal");

    const res = await understand(db, { query: "PR ревью" });
    const match = res.compact!.find((m) => m.id === "pr-35-open");
    expect(match).toBeDefined();
    expect(match!.kind).toBe("journal");
  });

  it("export: kind=journal проходит в frontmatter как есть", async () => {
    await createConcept(db, {
      name: "pr-36-open",
      kind: "journal",
      summary: "PR #36 открыт, правки в feat/scan",
    });
    const outDir = path.join(tmpDir, "export");
    const diff = exportMarkdown(db, outDir);
    expect(diff.written).toBeGreaterThan(0);
    const text = fs.readFileSync(path.join(outDir, "pr-36-open.md"), "utf-8");
    expect(text).toContain("kind: journal");
  });

  it("веб-эксплорер: journal в KIND_COLORS и KIND_ORDER (web/index.html)", () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const html = fs.readFileSync(path.join(projectRoot, "web", "index.html"), "utf-8");
    expect(html).toContain("journal");
    // порядок фильтра и палитра: journal объявлен рядом с остальными kinds
    expect(html).toMatch(/KIND_ORDER\s*=\s*\[[^\]]*'journal'/);
    expect(html).toMatch(/KIND_COLORS\s*=\s*\{[^}]*journal:/);
  });

  it("decision не заменяется: decision создаётся как раньше, journal — не опора и не решение", async () => {
    // journal без опор законен (он не опора и не решение); контракт decision
    // (опоры, require_support в строгом режиме) не расширялся — journal в
    // него не входит
    const res = await createConcept(db, {
      name: "journal-no-support",
      kind: "journal",
      summary: "Сборка 2026-11-15 прошла зелёной",
    });
    expect(res.id).toBe("journal-no-support");
    const decision = await createConcept(db, {
      name: "decision-plain",
      kind: "decision",
      summary: "Решение содержит опоры: запись без опор остаётся слабым звеном в отчётах",
      why: "контракт decision не меняется введением journal",
    });
    expect(decision.id).toBe("decision-plain");
    expect(db.getNode("decision-plain")!.kind).toBe("decision");
  });

  it("MCP tools/list публикует journal в описании и схемах create/update_concept", async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", pathToFileURL(path.join(projectRoot, "node_modules/tsx/dist/loader.mjs")).href,
        path.join(projectRoot, "src/index.ts"), "--db", path.join(tmpDir, "knowledge.db")],
      cwd: tmpDir,
      env: { ...env, NODE_OPTIONS: "", HOME: tmpDir, USERPROFILE: tmpDir, APPDATA: tmpDir, LOCALAPPDATA: tmpDir,
        XDG_CONFIG_HOME: tmpDir, XDG_CACHE_HOME: tmpDir, XDG_DATA_HOME: tmpDir,
        MEGAMEMORY_DB_PATH: path.join(tmpDir, "knowledge.db"), MEGAMEMORY_SEARCH: "fts",
        MEGAMEMORY_AUTO_MIGRATE: "0", MEGAMEMORY_AUTO_DIGEST: "0", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
      stderr: "pipe",
    });
    const client = new Client({ name: "journal-contract-test", version: "1" });
    try {
      await client.connect(transport, { timeout: 7_000 });
      const { tools } = await client.listTools({}, { timeout: 3_000 });
      const create = tools.find((tool) => tool.name === "create_concept")!;
      const update = tools.find((tool) => tool.name === "update_concept")!;
      expect(create.description).toContain("journal");
      expect(create.inputSchema.properties?.kind).toMatchObject({ enum: expect.arrayContaining(["journal"]) });
      expect(update.inputSchema.properties?.changes).toMatchObject({
        properties: { kind: { enum: expect.arrayContaining(["journal"]) } },
      });
    } finally {
      await client.close();
    }
  });
});
