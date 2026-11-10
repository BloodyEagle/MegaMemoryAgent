import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildGuideText } from "../guide.js";

const root = path.resolve(import.meta.dirname, "../..");

describe("S-04 README source commands on a fresh TEMP project", () => {
  it("executes the actual README argv and PY text/path contracts without shell", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mm-readme-пример с пробелами-"));
    try {
      const project = path.join(temp, "project");
      const scripts = path.join(temp, "skills с пробелами");
      fs.mkdirSync(path.join(project, "src"), { recursive: true });
      // Stage only the approved source package; never execute from installed profiles.
      const copyTree = (source: string, target: string): void => {
        fs.mkdirSync(target, { recursive: true });
        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
          const from = path.join(source, entry.name), to = path.join(target, entry.name);
          if (entry.isDirectory()) copyTree(from, to);
          else if (entry.isFile()) fs.writeFileSync(to, fs.readFileSync(from));
        }
      };
      for (const skill of ["token-economy-ts", "token-economy-py", "token-economy-har"]) {
        copyTree(`C:/p/agent-skills/skills/${skill}`, path.join(scripts, skill));
      }
      fs.writeFileSync(path.join(project, "src/a.ts"), 'import { Needle } from "./b.js";\n// строка "с кавычками"\n', "utf8");
      fs.writeFileSync(path.join(project, "src/b.ts"), "export const Needle = 1;\n", "utf8");
      fs.writeFileSync(path.join(project, "a.py"), "def apply_catalog():\n    return 1\n", "utf8");
      const har = path.join(project, "capture.har");
      fs.writeFileSync(har, JSON.stringify({ log: { version: "1.2", creator: { name: "fixture", version: "1" }, entries: [{
        startedDateTime: "2026-01-01T00:00:00Z", time: 1,
        request: { method: "GET", url: "https://example.invalid/Needle", httpVersion: "HTTP/1.1", headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
        response: { status: 200, statusText: "OK", httpVersion: "HTTP/1.1", headers: [], cookies: [], content: { size: 2, mimeType: "text/plain", text: "ok" }, redirectURL: "", headersSize: -1, bodySize: 2 },
        cache: {}, timings: { send: 0, wait: 1, receive: 0 },
      }] } }), "utf8");
      const en = fs.readFileSync(path.join(root, "README.md"), "utf8");
      const ru = fs.readFileSync(path.join(root, "README.ru.md"), "utf8");
      for (const doc of [en, ru]) {
        const block = doc.match(/megamemory bench --db "<owned-copy.db>"[\s\S]*?--te-arg "ext=[^"]+"/)!;
        expect(block).not.toBeNull();
        const argv = [...block[0].matchAll(/--te-arg "([^"]+)"/g)].map((m) => m[1]);
        argv[0] = path.join(scripts, "token-economy-ts/scripts/code-searcher.js");
        const query = 'строка "с кавычками"';
        const literal = argv.map((arg) => arg.replace("{query}", query));
        const match = spawnSync(process.execPath, literal, { cwd: project, encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
        expect(match.status, match.stderr).toBe(0);
        expect(JSON.parse(match.stdout)).toMatchObject({ count: 1, matches: [{ file: path.join("src", "a.ts"), line: 2, text: `// ${query}` }] });
        console.log("README-argv", JSON.stringify({ literal, cwd: project, status: match.status, stdout: match.stdout, stderr: match.stderr }));
        const pathLine = doc.split("\n").find((line) => line.startsWith('node "') && line.includes("op=path"))!;
        const pathArgs = pathLine.trimEnd().slice(pathLine.indexOf('" ', 6) + 2).split(" ");
        const graph = spawnSync(process.execPath, [path.join(scripts, "token-economy-ts/scripts/graph-tool.js"), ...pathArgs], { cwd: project, encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
        console.log("README-path", JSON.stringify({ argv: pathArgs, status: graph.status, stdout: graph.stdout, stderr: graph.stderr }));
        expect(graph.status, graph.stdout + graph.stderr).toBe(0);
        expect(JSON.parse(graph.stdout).chain).toBeInstanceOf(Array);
        const pyLine = doc.split("\n").find((line) => line.startsWith("python -I "))!;
        const queryPy = pyLine.match(/search "([^"]+)"/)![1];
        const py = spawnSync("python", ["-I", path.join(scripts, "token-economy-py/scripts/te.py"), "search", queryPy, "--root", project], { cwd: project, encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
        expect(py.status, py.stderr).toBe(0);
        expect(py.stdout).toContain("apply_catalog");
        expect(py.stdout).toContain("совпадений:");
        console.log("README-PY", JSON.stringify({ query: queryPy, status: py.status, stdout: py.stdout }));
        const harLine = doc.split("\n").find((line) => line.startsWith('node "') && line.includes("har.js"))!;
        const harQuery = harLine.match(/search "([^"]+)"/)![1];
        const negative = spawnSync(process.execPath, [path.join(scripts, "token-economy-har/har.js"), "search", harQuery, "--file", har, "--json"], { cwd: project, encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
        expect(negative.status).toBe(1);
        expect(negative.stderr).toBe("");
        expect(JSON.parse(negative.stdout)).toMatchObject({ command: "search", total: 0, items: [], truncated: false });
        console.log("README-HAR-negative", JSON.stringify({ query: harQuery, status: negative.status, stdout: negative.stdout, stderr: negative.stderr }));
      }
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });

  it("explains the actual wire metric and the ratio in both numeric directions", () => {
    const guide = buildGuideText();
    expect(guide).toContain("retrieval_wire_without_instructions");
    expect(guide).toContain("200 / 100 = 2");
    expect(guide).toContain("100 / 200 = 0.5");
    expect(guide).toContain("ratio > 1` means the graph is cheaper");
    expect(guide).toContain("ratio < 1` means the baseline is cheaper");
  });
});
