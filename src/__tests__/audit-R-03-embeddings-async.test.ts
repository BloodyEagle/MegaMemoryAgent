import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// R-03 (plan 08): managed async tests for the extractor singleton. The
// pipeline is a deferred resolved by hand — no model download, no real
// inference; IDLE_MS is injected per import via env, so the idle-unload
// path runs deterministically inside the test budget.

type ExtCall = {
  text: string;
  resolve: (out: { data: Float32Array }) => void;
  reject: (err: unknown) => void;
};

const h = vi.hoisted(() => {
  return {
    loads: [] as Array<{ resolve: (ext: unknown) => void; reject: (err: unknown) => void }>,
    extractorCalls: [] as ExtCall[][],
    disposed: [] as number[],
    disposeGates: [] as Array<() => void>,
  };
});

function makeExtractor(): unknown {
  const id = h.disposed.length;
  h.disposed.push(0);
  const calls: ExtCall[] = [];
  h.extractorCalls.push(calls);
  const ext = ((text: string) => {
    const call = {} as ExtCall;
    const p = new Promise<{ data: Float32Array }>((resolve, reject) => {
      call.resolve = resolve;
      call.reject = reject;
    });
    call.text = text;
    calls.push(call);
    return p;
  }) as unknown as { dispose: () => Promise<void> };
  ext.dispose = () => {
    h.disposed[id]! += 1;
    return new Promise<void>((resolve) => {
      h.disposeGates.push(resolve);
    });
  };
  return ext;
}

vi.mock("@huggingface/transformers", () => ({
  pipeline: () =>
    new Promise((resolve, reject) => {
      h.loads.push({ resolve, reject });
    }),
}));

let lastModule: { resetEmbeddingsForTests(): void } | null = null;

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

async function importEmbeddings(idleMs: string) {
  vi.resetModules();
  process.env.MEGAMEMORY_EMBED_IDLE_MS = idleMs;
  const mod = (await import("../embeddings.js")) as unknown as {
    embed(text: string): Promise<Buffer>;
    isModelLoaded(): boolean;
    resetEmbeddingsForTests(): void;
  };
  lastModule = mod;
  return mod;
}

beforeEach(() => {
  h.loads.length = 0;
  h.extractorCalls.length = 0;
  h.disposed.length = 0;
  h.disposeGates.length = 0;
});

afterEach(() => {
  try {
    lastModule?.resetEmbeddingsForTests();
  } finally {
    lastModule = null;
    delete process.env.MEGAMEMORY_EMBED_IDLE_MS;
  }
});

describe("R-03a: extractor singleton races", () => {
  it("concurrent first embeds load the pipeline once", async () => {
    const em = await importEmbeddings("0"); // unload disabled — no timer noise
    const p1 = em.embed("alpha");
    const p2 = em.embed("beta");
    await tick();

    expect(h.loads.length).toBe(1);

    h.loads[0]!.resolve(makeExtractor());
    await tick();
    const calls = h.extractorCalls[0]!;
    expect(calls.length).toBe(2);
    calls[0]!.resolve({ data: new Float32Array(384) });
    calls[1]!.resolve({ data: new Float32Array(384) });

    const [b1, b2] = await Promise.all([p1, p2]);
    expect(b1.length).toBe(384 * 4);
    expect(b2.length).toBe(384 * 4);
    expect(em.isModelLoaded()).toBe(true);
  });

  it("a failed load is not cached — the next embed retries the pipeline", async () => {
    const em = await importEmbeddings("0");
    const p1 = em.embed("x").catch((e: unknown) => e);
    await tick();
    h.loads[0]!.reject(new Error("download failed"));
    const err = await p1;
    expect(err).toBeInstanceOf(Error);

    const p2 = em.embed("y");
    await tick();
    expect(h.loads.length).toBe(2);
    const ext2 = makeExtractor(); // первый экстрактор не создавался — load был отклонён
    h.loads[1]!.resolve(ext2);
    await tick();
    const calls2 = h.extractorCalls[h.extractorCalls.length - 1]!;
    calls2[0]!.resolve({ data: new Float32Array(384) });
    await p2;
    expect(em.isModelLoaded()).toBe(true);
  });

  it("a dispose-in-progress session is never handed out; the next embed reloads", async () => {
    const em = await importEmbeddings("30");
    const p1 = em.embed("first");
    await tick();
    expect(h.loads.length).toBe(1);
    h.loads[0]!.resolve(makeExtractor());
    await tick();
    h.extractorCalls[0]![0]!.resolve({ data: new Float32Array(384) });
    await p1;

    // idle 30 ms: wait out the unload timer; our dispose gate holds it open
    await tick(80);
    expect(h.disposed[0]).toBe(1);
    expect(h.disposeGates.length).toBe(1);

    const loadsAtDispose = h.loads.length;
    const p2 = em.embed("second");
    await tick();

    // R-03b: before the fix the disposing extractor stayed assigned and was
    // reused mid-disposal; now the slot is null and a fresh load starts.
    expect(h.loads.length).toBe(loadsAtDispose + 1);
    expect(em.isModelLoaded()).toBe(false);
    expect(h.extractorCalls[0]!.length).toBe(1);

    h.disposeGates[0]!();
    h.loads[1]!.resolve(makeExtractor());
    await tick();
    h.extractorCalls[1]![0]!.resolve({ data: new Float32Array(384) });
    await p2;

    expect(em.isModelLoaded()).toBe(true);
    expect(h.disposed[0]).toBe(1); // старая сессия dispose-ится ровно один раз
  });
});
