import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import ts from "typescript";
import { ROOT, runBounded, reportFailure } from "./verify-utils.mjs";

const MAX_FILES = 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

// Deliberately small lint policy, not an ESLint compatibility layer:
// UTF-8, parser diagnostics, no debugger, and no duplicate literal keys.
export function lintText(text, filename, kind = ts.ScriptKind.TS) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, kind);
  const problems = source.parseDiagnostics.map((diagnostic) => ({
    position: diagnostic.start || 0,
    rule: `syntax/TS${diagnostic.code}`,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
  }));
  function visit(node) {
    if (ts.isDebuggerStatement(node)) problems.push({ position: node.getStart(source), rule: "no-debugger", message: "Remove debugger statements." });
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set();
      for (const member of node.properties) {
        if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) continue;
        if (ts.isComputedPropertyName(member.name)) continue;
        const name = member.name.text;
        if (names.has(name)) problems.push({ position: member.getStart(source), rule: "no-duplicate-object-key", message: `Duplicate object key ${JSON.stringify(name)}.` });
        names.add(name);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return problems.map((problem) => {
    const { line, character } = source.getLineAndCharacterOfPosition(problem.position);
    return { file: filename, line: line + 1, column: character + 1, rule: problem.rule, message: problem.message };
  });
}

export function lintProject() {
  const files = [];
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`LINT_SYMLINK_FORBIDDEN ${file}`);
      if (entry.isDirectory()) { if (!["node_modules", "dist", "vendor"].includes(entry.name)) collect(file); }
      else if (/\.(?:[cm]?[jt]sx?|html)$/.test(entry.name)) files.push(file);
      if (files.length > MAX_FILES) throw new Error(`LINT_FILE_LIMIT ${MAX_FILES}`);
    }
  }
  for (const name of ["src", "tests", "web", "scripts"]) collect(path.join(ROOT, name));
  files.push(path.join(ROOT, "vitest.config.ts"));
  let totalBytes = 0, inlineScripts = 0;
  const problems = [];
  for (const file of files) {
    const size = fs.statSync(file).size;
    totalBytes += size;
    if (size > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) throw new Error(`LINT_BYTE_LIMIT ${file}`);
    const relative = path.relative(ROOT, file).replaceAll("\\", "/");
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file)); }
    catch { problems.push({ file: relative, line: 1, column: 1, rule: "utf8", message: "Invalid UTF-8 encoding." }); continue; }
    if (file.endsWith(".html")) {
      for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        if (/\bsrc\s*=/i.test(match[1]) || /\btype\s*=\s*["'](?:application\/ld\+json|application\/json)["']/i.test(match[1])) continue;
        const offset = match.index + match[0].indexOf(">") + 1;
        const lineOffset = text.slice(0, offset).split("\n").length - 1;
        inlineScripts++;
        problems.push(...lintText(match[2], relative, ts.ScriptKind.JS).map((problem) => ({ ...problem, line: problem.line + lineOffset })));
      }
    } else {
      const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
      problems.push(...lintText(text, relative, kind));
    }
  }
  if (inlineScripts === 0) throw new Error("LINT_UI_SCRIPT_MISSING");
  for (const problem of problems) console.error(`${problem.file}:${problem.line}:${problem.column} ${problem.rule}: ${problem.message}`);
  console.log(JSON.stringify({ lint: problems.length === 0 ? "pass" : "fail", files: files.length, inline_ui_scripts: inlineScripts, bytes: totalBytes, diagnostics: problems.length, typescript: ts.version, vendor: "excluded" }));
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--worker") process.exitCode = lintProject();
    else if (process.argv.length === 2) await runBounded(process.execPath, [fileURLToPath(import.meta.url), "--worker"], { label: "lint" });
    else throw new Error("Usage: node scripts/lint.mjs");
  } catch (error) { reportFailure(error); }
}
