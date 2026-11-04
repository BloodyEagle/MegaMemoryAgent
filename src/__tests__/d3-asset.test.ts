import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "url";
import { D3_CDN_URL, D3_LOCAL_SRC, d3VendorFile, resolveD3Src } from "../d3-asset.js";
import { healthPayload } from "../web.js";
import { KnowledgeDB } from "../db.js";
import { ensureSchema } from "../migrate-schema.js";
import { closeAndCleanup } from "./helpers/cleanup.js";

vi.mock("../embeddings.js", () => ({
  embed: vi.fn(async () => Buffer.alloc(0)),
  embeddingText: vi.fn((name: string, kind: string, summary: string) => `${kind}: ${name} — ${summary}`),
  findTopK: vi.fn(),
  embedForStorage: vi.fn(async () => Buffer.alloc(0)),
  vectorSearchEnabled: vi.fn(() => false),
  isModelLoaded: vi.fn(() => false),
  isTextOnlySearchMode: vi.fn(() => true),
  initializeEmbeddings: vi.fn(async () => undefined),
}));

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let tmpDir: string;
let db: KnowledgeDB;

afterEach(async () => {
  if (db) await closeAndCleanup(db, tmpDir);
});

describe("2.1.9 F1: d3 поставляется с пакетом", () => {
  it("1. в tarball входит web/vendor/d3.min.js — иначе страница serve пустая", () => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      shell: true,
      timeout: 120_000,
    });
    const pack = JSON.parse(out)[0];
    const paths = (pack.files as Array<{ path: string }>).map((f) => f.path);
    expect(paths).toContain("web/vendor/d3.min.js");
  });

  it("2. вендорный файл на диске: {{D3_SRC}} = /vendor/d3.min.js, источник local", () => {
    // файл лежит в репозитории и едет в пакет
    expect(fs.existsSync(d3VendorFile())).toBe(true);
    const r = resolveD3Src();
    expect(r.source).toBe("local");
    expect(r.src).toBe(D3_LOCAL_SRC);
    expect(r.note).toBeNull();
  });

  it("3. файла нет и env не задан: CDN-фолбэк с напечатанной строкой, не молчивый 404", () => {
    const prev = process.env.MEGAMEMORY_D3_URL;
    delete process.env.MEGAMEMORY_D3_URL;
    try {
      const r = resolveD3Src(() => false);
      expect(r.source).toBe("cdn");
      expect(r.src).toBe(D3_CDN_URL);
      expect(r.note).toContain("CDN");
      expect(r.note).toContain("локальный файл не найден");
    } finally {
      if (prev !== undefined) process.env.MEGAMEMORY_D3_URL = prev;
    }
  });

  it("4. MEGAMEMORY_D3_URL перебивает и вендорный файл, и CDN", () => {
    const prev = process.env.MEGAMEMORY_D3_URL;
    process.env.MEGAMEMORY_D3_URL = "https://mirror.local/d3.min.js";
    try {
      expect(resolveD3Src(() => true)).toEqual({
        src: "https://mirror.local/d3.min.js",
        source: "env",
        note: null,
      });
      expect(resolveD3Src(() => false).source).toBe("env");
    } finally {
      if (prev === undefined) delete process.env.MEGAMEMORY_D3_URL;
      else process.env.MEGAMEMORY_D3_URL = prev;
    }
  });

  it("5. /api/health содержит d3_source: local | cdn | env", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-d3-health-"));
    db = new KnowledgeDB(path.join(tmpDir, "knowledge.db"));
    ensureSchema(db);
    const payload = healthPayload(db);
    expect(["local", "cdn", "env"]).toContain(payload.d3_source);
    // метрики U3 на месте рядом с новым полем
    expect(payload.nodes).toBe(0);
    expect(payload.rss_mb).toBeGreaterThan(0);
  });

  it("6. на странице ровно один <script src> с d3, подстановка не пустая", () => {
    const html = fs.readFileSync(path.join(PROJECT_ROOT, "web", "index.html"), "utf-8");
    const placeholders = html.match(/\{\{D3_SRC\}\}/g) ?? [];
    expect(placeholders).toHaveLength(1);
    expect(html).toContain('<script src="{{D3_SRC}}"></script>');
    // подстановка даёт непустой src в любом из трёх режимов
    const r = resolveD3Src();
    expect(r.src.length).toBeGreaterThan(0);
  });

  it("7. вендорный d3 — минифицированный v7 с версией в первой строке", () => {
    const buf = fs.readFileSync(d3VendorFile());
    expect(buf.length).toBeGreaterThan(200_000);
    const nl = buf.indexOf("\n");
    const firstLine = buf.toString("utf-8", 0, nl === -1 ? 200 : nl);
    expect(firstLine).toMatch(/d3js\.org v7\./);
  });
});
