import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupDir } from "./helpers/cleanup.js";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  candidates: vi.fn(() => ({ candidates: [], candidates_truncated: 0 })),
  merge: vi.fn(),
}));
vi.mock("../db.js", () => ({ KnowledgeDB: class {
  constructor(file: string) { mocks.open(file); }
  close() {}
} }));
vi.mock("../consolidate.js", () => ({ findDuplicates: mocks.candidates, mergeNodes: vi.fn() }));
vi.mock("../merge.js", () => ({
  MergeEngine: class { merge(...args: unknown[]) { return mocks.merge(...args); } },
  stripMergeSuffix: (id: string) => id,
  MERGE_SUFFIX_LEFT: "::left", MERGE_SUFFIX_RIGHT: "::right",
}));
vi.mock("../tools.js", () => ({ resolveConflict: vi.fn() }));
import { runConsolidate } from "../consolidate-cli.js";
import { runMerge } from "../merge-cli.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mm-cli-contract-"));
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code: number) => { throw new Error(`exit:${code}`); }) as never);
});
afterEach(async () => { vi.restoreAllMocks(); await cleanupDir(tmp); });

function sentinel(name: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, name);
  return file;
}

describe("P-01 CLI boundaries", () => {
  it("F-01: explicit fractional threshold equals default and preserves 0.99", async () => {
    const file = sentinel("input.db");
    for (const [flags, threshold] of [[[], 0.95], [["--threshold", "0.95"], 0.95], [["--threshold", "0.99"], 0.99], [["--threshold=0.99"], 0.99]] as const) {
      await runConsolidate(["--db", file, ...flags]);
      expect(mocks.candidates).toHaveBeenLastCalledWith(expect.anything(), { threshold, limit: 100 });
    }
    expect(fs.readFileSync(file, "utf8")).toBe("input.db");
  });

  it.each(["NaN", "Infinity", "0.95junk", "", "-0.1", "1.01"])("F-01: invalid threshold %j rejects before database access", async (value) => {
    const file = sentinel("input.db");
    await expect(runConsolidate(["--db", file, "--threshold", value])).rejects.toThrow();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.candidates).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5", "10junk", "", "Infinity"])("F-01: invalid limit %j rejects before database access", async (value) => {
    const file = sentinel("input.db");
    await expect(runConsolidate(["--db", file, "--limit", value])).rejects.toThrow();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.candidates).not.toHaveBeenCalled();
  });

  it.each([["--into"], ["--into", ""], ["--into="], ["--into", "--json"]])("F-02: malformed output flags %j never call the engine or overwrite inputs", async (...flags) => {
    const left = sentinel("left.db"), right = sentinel("right.db");
    await expect(runMerge([left, right, ...flags])).rejects.toThrow();
    expect(mocks.merge).not.toHaveBeenCalled();
    expect(fs.readFileSync(left, "utf8")).toBe("left.db");
    expect(fs.readFileSync(right, "utf8")).toBe("right.db");
    expect(fs.readdirSync(tmp).sort()).toEqual(["left.db", "right.db"]);
  });

  it("F-02: explicit equals output reaches the engine as one path", async () => {
    const left = sentinel("left.db"), right = sentinel("right.db"), output = path.join(tmp, "output file.db");
    mocks.merge.mockReturnValue({ clean: 0, removedClean: 0, conceptConflicts: 0, edgeConflicts: 0 });
    await runMerge([left, right, `--into=${output}`]);
    expect(mocks.merge).toHaveBeenCalledWith(left, right, output, { leftLabel: undefined, rightLabel: undefined });
    expect(fs.readFileSync(left, "utf8")).toBe("left.db");
  });
});
