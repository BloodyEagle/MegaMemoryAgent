import { describe, it, expect } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function httpBoundary(options: { vector?: boolean; request?: string; headers?: Record<string, string>; streamError?: boolean } = {}) {
  const source = fs.readFileSync(new URL("../web.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("web.ts", source, ts.ScriptTarget.Latest, true);
  let callback = "";
  const functions: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && ["json", "html", "notFound", "hostMatches", "sameOrigin", "escapeHtmlAttribute", "webSecurityHeaders"].includes(node.name.text)) functions.push(node.getText(ast));
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "http.createServer") callback = node.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const responses: Array<{ status: number; body: unknown }> = [];
  const headers: Record<string, string> = {};
  let loads = 0, searches = 0, destroyed = false;
  const req = { url: options.request ?? "/api/search?q=needle", method: "GET", headers: { host: "127.0.0.1:8765", ...options.headers } };
  const res = {
    headersSent: false, writableEnded: false, destroyed: false,
    setHeader: (key: string, value: string) => { headers[key.toLowerCase()] = value; },
    writeHead: (status: number, values: Record<string, string>) => { res.headersSent = true; responses.push({ status, body: null }); Object.assign(headers, values); },
    end: (body: string) => { res.writableEnded = true; try { responses.at(-1)!.body = JSON.parse(body); } catch { responses.at(-1)!.body = body; } },
    destroy: () => { destroyed = true; },
    on: () => res,
  };
  const stream = { on: (_: string, cb: () => void) => { if (options.streamError) queueMicrotask(cb); return stream; }, pipe: () => res, destroy() {} };
  const context = vm.createContext({
    URL, Buffer, console: { error() {} }, ALLOWED_HOSTNAMES: new Set(["localhost", "127.0.0.1", "[::1]"]),
    port: 8765, req, res, db: {}, embeddingsReady: false, embeddingInitError: null,
    vectorSearchEnabled: () => options.vector ?? false, isTextOnlySearchMode: () => false,
    initializeEmbeddings: async () => { loads++; throw new Error("no model"); },
    understand: async () => { searches++; return { matches: [{ id: "needle", name: "needle", kind: "feature", summary: "text", similarity: 1, file_refs: [] }] }; },
    pc: { red: (s: string) => s }, htmlContent: "<html>fixture</html>", csp: "default-src 'self'; frame-ancestors 'none'", resolveWebDir: () => "C:/owned/web",
    path: { normalize: (s: string) => s, join: (...parts: string[]) => parts.join("/"), sep: "/", extname: () => ".js" },
    fs: { existsSync: () => true, statSync: () => ({ isFile: () => true }), createReadStream: () => stream },
  });
  const run = (text: string) => vm.runInContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  run(functions.join("\n"));
  return {
    async request() { run(`(${callback})(req, res);`); await new Promise<void>(r => setImmediate(r)); return responses; },
    headers, loads: () => loads, searches: () => searches, destroyed: () => destroyed,
  };
}

describe("E03 HTTP search vector enable gate", () => {
  it("disabled vectors return FTS200 without initializing a model", async () => {
    const http = httpBoundary();
    expect((await http.request())[0]).toMatchObject({ status: 200, body: { matches: [{ id: "needle" }] } });
    expect(http.loads()).toBe(0);
    expect(http.searches()).toBe(1);
  });
  it("enabled vectors expose model failure as HTTP503, not empty success", async () => {
    const http = httpBoundary({ vector: true });
    expect((await http.request())[0].status).toBe(503);
    expect(http.loads()).toBe(1);
  });
});

describe("R07 HTTP defensive boundary", () => {
  it.each(["https://127.0.0.1:8765/ui", "http://user@127.0.0.1:8765/ui"])("rejects non-origin Referer %s", async referer => {
    const http = httpBoundary({ headers: { referer } });
    expect((await http.request())[0].status).toBe(403);
  });
  it("malformed percent-encoded URL returns 400", async () => {
    const http = httpBoundary({ request: "/vendor/%ZZ.js" });
    expect((await http.request())[0].status).toBe(400);
  });
  it("HTML carries CSP framing and referrer headers", async () => {
    const http = httpBoundary({ request: "/" });
    expect((await http.request())[0].status).toBe(200);
    expect(http.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(http.headers["x-frame-options"]).toBe("DENY");
    expect(http.headers["referrer-policy"]).toBe("no-referrer");
  });
  it("static stream failure destroys only the response after headers", async () => {
    const http = httpBoundary({ request: "/vendor/d3.min.js", streamError: true });
    await http.request();
    expect(http.destroyed()).toBe(true);
  });
});
