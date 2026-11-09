import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

// Own adapter: reuse the inert tree, without importing native audit fixtures.
// Add the platform AbortController missing from the shared VM. No network I/O.
const helperUrl = new URL("./helpers/audit-dom.ts", import.meta.url);
const source = fs.readFileSync(helperUrl, "utf8")
  .replace('import { AuditHarnessError } from "./audit.js";', 'class AuditHarnessError extends Error {}')
  .replaceAll("import.meta.url", JSON.stringify(helperUrl.href))
  .replace("document, Element: AuditElement, URL,", "document, Element: AuditElement, AbortController, URL,");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const exports: Record<string, any> = {};
vm.runInNewContext(`(function(require, exports) { ${compiled}\n})`, {
  URL, URLSearchParams, AbortController, Buffer, structuredClone, setImmediate, console,
})(createRequire(import.meta.url), exports);
export const p14Dom = exports.auditDom as typeof import("./helpers/audit-dom.js").auditDom;
export const graphNode = exports.graphNode as typeof import("./helpers/audit-dom.js").graphNode;
export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
