import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

const indexUrl = new URL("../index.ts", import.meta.url);
const source = readFileSync(indexUrl, "utf8");
const { version: packageVersion } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as { version: string };

function sourceVersion(): string {
  const expression = source.match(/const VERSION = ([\s\S]*?);/)?.[1];
  if (!expression) throw new Error("VERSION initializer not found");
  expect(expression).toContain("readFileSync");
  expect(expression).toContain('"package.json"');
  const version: unknown = runInNewContext(
    expression.replace("import.meta.url", JSON.stringify(indexUrl.href)),
    { readFileSync, resolve, dirname, fileURLToPath }
  );
  if (typeof version !== "string") throw new Error("VERSION must be a string");
  return version;
}

function sourceInstructions(version: string): string {
  const expression = source.match(/const MCP_INSTRUCTIONS = (`[^`]*`);/)?.[1];
  if (!expression) throw new Error("MCP_INSTRUCTIONS initializer not found");
  expect(expression).toContain("${VERSION}");
  const instructions: unknown = runInNewContext(expression, { VERSION: version });
  if (typeof instructions !== "string") throw new Error("Instructions must be a string");
  return instructions;
}

function sourceServer(version: string, instructions: string): McpServer {
  const expression = source.match(/const server = (new McpServer\([\s\S]*?\));/)?.[1];
  if (!expression) throw new Error("McpServer initializer not found");
  // Execute the production constructor, not a hand-written copy of its options.
  const server: unknown = runInNewContext(expression, {
    McpServer, VERSION: version, MCP_INSTRUCTIONS: instructions,
  });
  if (!(server instanceof McpServer)) throw new Error("Expected a McpServer");
  return server;
}

async function initialize(server: McpServer): Promise<{
  instructions: string | undefined;
  serverInfo: ReturnType<Client["getServerVersion"]>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-instructions-test", version: "1" });
  try {
    await server.connect(serverTransport);
    // Client.connect sends initialize and reads the actual SDK wire response.
    await client.connect(clientTransport, { timeout: 2_000 });
    return { instructions: client.getInstructions(), serverInfo: client.getServerVersion() };
  } finally {
    try { await client.close(); } finally { await server.close(); }
  }
}

describe("MCP initialize instructions", () => {
  it("reads the source VERSION from package.json rather than duplicating it", () => {
    expect(sourceVersion()).toBe(packageVersion);
  });

  it("publishes short Russian instructions in the actual initialize response", async () => {
    const version = sourceVersion();
    const expected = sourceInstructions(version);
    const result = await initialize(sourceServer(version, expected));
    expect(result.serverInfo).toMatchObject({ name: "megamemory", version: packageVersion });
    expect(result.serverInfo).not.toHaveProperty("instructions");
    expect(result.instructions).toBe(expected);
    expect(expected).toContain(`MegaMemory ${packageVersion}`);
    expect(expected.length).toBeLessThanOrEqual(400);
    expect(expected).toContain("проверенный вывод");
    for (const name of ["understand", "create_concept", "evidence", "link", "next.record", "include_source", "stale_warning"]) {
      expect(expected).toContain(name);
    }
    // Пояснение причин пустой выдачи дублирует meta.reason ответа — в тексте ему не место.
    expect(expected).not.toContain("reason=");
    for (const name of ["remove_concept", "merge", "resolve_conflict", "expire", "consolidate"]) {
      expect(expected).not.toContain(name);
    }
  });

  it("does not publish instructions misplaced in the first serverInfo argument", async () => {
    const serverInfo = { name: "wrong-options-location", version: packageVersion, instructions: "misplaced" };
    const result = await initialize(new McpServer(serverInfo));
    expect(result.instructions).toBeUndefined();
  });
});
