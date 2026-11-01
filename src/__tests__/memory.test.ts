import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// F9.9: idle-unload lifecycle of the embedding model.
// IDLE_MS is read at import time, so every case re-imports the module
// with its own env via vi.resetModules.

const { pipelineMock } = vi.hoisted(() => {
  const calls: Array<{ model: string; options: unknown }> = [];
  let instances = 0;
  const pipelineMock = vi.fn(async (_task: string, model: string, options: unknown) => {
    calls.push({ model, options });
    instances += 1;
    const fn = async (text: string) => {
      void text;
      const data = new Float32Array([0.1, 0.2, 0.3]);
      return { data };
    };
    (fn as unknown as { __instance: number }).__instance = instances;
    return Object.assign(fn, {
      dispose: vi.fn(async () => undefined),
    });
  });
  return { pipelineMock };
});

vi.mock("@huggingface/transformers", () => ({
  pipeline: pipelineMock,
}));

const originalEnv = { ...process.env };

beforeEach(() => {
  pipelineMock.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  process.env.MEGAMEMORY_EMBED_IDLE_MS = originalEnv.MEGAMEMORY_EMBED_IDLE_MS;
  process.env.MEGAMEMORY_SEARCH = originalEnv.MEGAMEMORY_SEARCH;
  vi.resetModules();
});

async function loadEmbeddings(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return import("../embeddings.js");
}


describe("embedding model memory lifecycle (F9)", () => {
  it("unloads the model after IDLE_MS of silence", async () => {
    const emb = await loadEmbeddings({ MEGAMEMORY_EMBED_IDLE_MS: "1000" });
    await emb.embed("hello");
    expect(emb.isModelLoaded()).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(emb.isModelLoaded()).toBe(false);
  });

  it("does not unload while withExtractor is running, even if the timer fires", async () => {
    const emb = await loadEmbeddings({ MEGAMEMORY_EMBED_IDLE_MS: "1000" });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const promise = emb.withExtractor(async () => {
      await gate;
      return "done";
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(emb.isModelLoaded()).toBe(true); // active embed blocks the unload

    release();
    await promise;
    await vi.advanceTimersByTimeAsync(1000);
    expect(emb.isModelLoaded()).toBe(false); // unloads after it finishes
  });

  it("re-creates the pipeline after an unload (dispose + re-init)", async () => {
    const emb = await loadEmbeddings({ MEGAMEMORY_EMBED_IDLE_MS: "1000" });
    await emb.embed("first");
    await vi.advanceTimersByTimeAsync(1000);
    expect(emb.isModelLoaded()).toBe(false);

    await emb.embed("second");
    expect(emb.isModelLoaded()).toBe(true);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it("MEGAMEMORY_EMBED_IDLE_MS=0 disables unloading", async () => {
    const emb = await loadEmbeddings({ MEGAMEMORY_EMBED_IDLE_MS: "0" });
    await emb.embed("hello");

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(emb.isModelLoaded()).toBe(true);
  });

  it("MEGAMEMORY_SEARCH=fts never initializes the pipeline", async () => {
    const emb = await loadEmbeddings({ MEGAMEMORY_SEARCH: "fts" });
    const { KnowledgeDB } = await import("../db.js");
    const { ensureSchema } = await import("../migrate-schema.js");
    const { hybridSearch } = await import("../search.js");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-fts-mode-"));
    const db = new KnowledgeDB(path.join(dir, "k.db"));
    try {
      ensureSchema(db);
      db.insertNode({ id: "книга", name: "Книга", kind: "module", summary: "заметки" });

      const hits = await hybridSearch(db, "книга", { topK: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(pipelineMock).not.toHaveBeenCalled();
      expect(emb.isModelLoaded()).toBe(false);
    } finally {
      db.close();
    }
  });
});
