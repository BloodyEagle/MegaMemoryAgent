import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_TOOL_NAMES, TOOL_NAMES, parseToolSurface } from "../tool-surface.js";
import { ensureSchema } from "../migrate-schema.js";
import { auditFixture, type AuditFixture } from "./helpers/audit.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));

describe("parseToolSurface (MEGAMEMORY_TOOLS)", () => {
  it("no value, empty value and explicit all give every tool, mode all", () => {
    for (const value of [undefined, "", "  ", "all"]) {
      const surface = parseToolSurface(value);
      expect(surface.mode).toBe("all");
      expect(surface.enabled.size).toBe(TOOL_NAMES.length);
      for (const name of TOOL_NAMES) expect(surface.enabled.has(name)).toBe(true);
    }
  });

  it("core gives exactly the read→write→link→confirm→verify loop", () => {
    const surface = parseToolSurface("core");
    expect(surface.mode).toBe("core");
    expect([...surface.enabled].sort()).toEqual([...CORE_TOOL_NAMES].sort());
    expect(surface.enabled.size).toBe(8);
    expect(surface.enabled.has("understand")).toBe(true);
    expect(surface.enabled.has("trail_save")).toBe(false);
    expect(surface.enabled.has("board")).toBe(false);
  });

  it("a comma list gives exactly the named tools, with whitespace trimmed", () => {
    const surface = parseToolSurface(" understand , link ");
    expect(surface.mode).toBe("list");
    expect([...surface.enabled].sort()).toEqual(["link", "understand"]);
  });

  it("an unknown name warns to stderr and is skipped, not fatal", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const surface = parseToolSurface("understand,bogus");
      expect(surface.mode).toBe("list");
      expect([...surface.enabled]).toEqual(["understand"]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[0]).toContain("bogus");
    } finally {
      error.mockRestore();
    }
  });

  it("a list of only unknown names enables nothing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const surface = parseToolSurface("bogus,also-bogus");
      expect(surface.mode).toBe("list");
      expect(surface.enabled.size).toBe(0);
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });
});

describe("tools/list honors MEGAMEMORY_TOOLS on the real server", () => {
  let fixture: AuditFixture;
  let closeServer: (() => Promise<void>) | undefined;

  beforeEach(() => { fixture = auditFixture(); });
  afterEach(async () => {
    try { await closeServer?.(); } finally { closeServer = undefined; await fixture.close(); }
  });

  async function startServer(tools: string | undefined): Promise<Client> {
    const db = fixture.db("surface.db");
    try { ensureSchema(db); } finally { await fixture.release(db); }
    const profile = fixture.profile();
    const base = Object.fromEntries(
      Object.entries(profile.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    delete base.MEGAMEMORY_TOOLS;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", pathToFileURL(path.join(repository, "node_modules/tsx/dist/loader.mjs")).href,
        path.join(repository, "src/index.ts"), "--db", fixture.file("surface.db")],
      cwd: fixture.root, stderr: "pipe",
      env: { ...base, NODE_OPTIONS: "", MEGAMEMORY_SEARCH: "fts", MEGAMEMORY_AUTO_MIGRATE: "0", MEGAMEMORY_AUTO_DIGEST: "0",
        MEGAMEMORY_TELEMETRY_PATH: "", XDG_CONFIG_HOME: fixture.file("config"), XDG_CACHE_HOME: fixture.file("cache"),
        XDG_DATA_HOME: fixture.file("data"), HF_HOME: fixture.file("hf"), HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
        ...(tools !== undefined ? { MEGAMEMORY_TOOLS: tools } : {}) },
    });
    const stderrChunks: string[] = [];
    transport.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));
    const client = new Client({ name: "tool-surface-regression", version: "1" });
    await client.connect(transport, { timeout: 15_000 });
    closeServer = async () => { await client.close(); };
    (client as unknown as { stderrText: () => string }).stderrText = () => stderrChunks.join("");
    return client;
  }

  async function listedNames(client: Client): Promise<string[]> {
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name).sort();
  }

  it("without env all 26 tools register — the default surface does not change", async () => {
    const client = await startServer(undefined);
    expect(await listedNames(client)).toEqual([...TOOL_NAMES].sort());
  });

  it("MEGAMEMORY_TOOLS=all registers all 26 too", async () => {
    const client = await startServer("all");
    expect(await listedNames(client)).toEqual([...TOOL_NAMES].sort());
  });

  it("core exposes exactly the eight loop tools", async () => {
    const client = await startServer("core");
    expect(await listedNames(client)).toEqual([...CORE_TOOL_NAMES].sort());
  });

  it("an explicit list exposes exactly the named tools", async () => {
    const client = await startServer("understand,link");
    expect(await listedNames(client)).toEqual(["link", "understand"]);
  });

  it("an unknown name is skipped with a stderr warning, known ones still register", async () => {
    const client = await startServer("understand,bogus");
    expect(await listedNames(client)).toEqual(["understand"]);
    const stderr = (client as unknown as { stderrText: () => string }).stderrText();
    expect(stderr).toContain("bogus");
    expect(stderr).toContain("MEGAMEMORY_TOOLS");
  });
});
