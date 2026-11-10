import fs from "node:fs";
import vm from "node:vm";
import { AuditHarnessError } from "./audit.js";

type Listener = (event: any) => unknown;
type Part = AuditElement | string;

function decode(text: string): string {
  const names: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", times: "×" };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|times);/gi, (all, name: string) => {
    if (!name.startsWith("#")) return names[name.toLowerCase()] ?? all;
    const value = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "\ufffd";
  });
}

function encode(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** An inert HTML tree, not a browser or a sandbox for executing hostile JavaScript. */
export class AuditElement {
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  parts: Part[] = [];
  parentElement: AuditElement | null = null;
  readonly style: Record<string, string> = {};
  onclick: Listener | null = null;
  onchange: Listener | null = null;
  private inputValue: string | undefined;
  private checkedValue: boolean | undefined;

  constructor(readonly tagName: string) {}

  get children(): AuditElement[] { return this.parts.filter((part): part is AuditElement => part instanceof AuditElement); }
  get parentNode(): AuditElement | null { return this.parentElement; }
  get id(): string { return this.getAttribute("id") ?? ""; }
  set id(value: string) { this.setAttribute("id", value); }
  get className(): string { return this.getAttribute("class") ?? ""; }
  set className(value: string) { this.setAttribute("class", value); }
  get textContent(): string { return this.parts.map((part) => typeof part === "string" ? part : part.textContent).join(""); }
  set textContent(value: string) { this.replaceParts([String(value)]); }
  get innerHTML(): string {
    return this.parts.map((part) => typeof part === "string" ? encode(part) : part.outerHTML).join("");
  }
  set innerHTML(value: string) { this.replaceParts(parseHtml(String(value)).parts); }
  get outerHTML(): string {
    const attrs = [...this.attributes].map(([key, value]) => ` ${key}="${encode(value)}"`).join("");
    return `<${this.tagName.toLowerCase()}${attrs}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }
  get value(): string {
    if (this.inputValue !== undefined) return this.inputValue;
    if (this.tagName === "SELECT") {
      const options = this.querySelectorAll("option");
      return (options.find((option) => option.hasAttribute("selected")) ?? options[0])?.getAttribute("value") ?? "";
    }
    return this.getAttribute("value") ?? "";
  }
  set value(value: string) { this.inputValue = String(value); }
  get checked(): boolean { return this.checkedValue ?? this.hasAttribute("checked"); }
  set checked(value: boolean) { this.checkedValue = value; }
  get dataset(): Record<string, string> {
    const attribute = (key: string) => `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    const values = Object.fromEntries([...this.attributes].filter(([name]) => name.startsWith("data-")).map(([name, value]) => [
      name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), value,
    ]));
    return new Proxy(values, {
      set: (target, key: string, value) => { this.setAttribute(attribute(key), value); target[key] = String(value); return true; },
      deleteProperty: (target, key: string) => { this.removeAttribute(attribute(key)); delete target[key]; return true; },
    });
  }
  get classList() {
    const values = () => new Set(this.className.split(/\s+/).filter(Boolean));
    return {
      contains: (name: string) => values().has(name),
      add: (...names: string[]) => { this.className = [...new Set([...values(), ...names])].join(" "); },
      remove: (...names: string[]) => { this.className = [...values()].filter((name) => !names.includes(name)).join(" "); },
      toggle: (name: string, force?: boolean) => {
        const enabled = force ?? !values().has(name);
        if (enabled) this.classList.add(name); else this.classList.remove(name);
        return enabled;
      },
    };
  }
  getAttribute(name: string): string | null { return this.attributes.get(name.toLowerCase()) ?? null; }
  hasAttribute(name: string): boolean { return this.attributes.has(name.toLowerCase()); }
  setAttribute(name: string, value: unknown): void { this.attributes.set(name.toLowerCase(), String(value)); }
  removeAttribute(name: string): void { this.attributes.delete(name.toLowerCase()); }
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener(type: string, listener: Listener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener)); }
  appendChild(child: AuditElement): AuditElement { child.remove(); child.parentElement = this; this.parts.push(child); return child; }
  removeChild(child: AuditElement): void { this.parts = this.parts.filter((part) => part !== child); child.parentElement = null; }
  remove(): void { this.parentElement?.removeChild(this); }
  contains(node: unknown): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  closest(selector: string): AuditElement | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  matches(selector: string): boolean {
    const match = /^([\w-]+)?(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\])?$/.exec(selector);
    if (!match) throw new AuditHarnessError(`Unsupported audit DOM selector: ${selector}`);
    const [, tag, id, className, attr, value] = match;
    return (!tag || this.tagName === tag.toUpperCase()) && (!id || this.id === id)
      && (!className || this.classList.contains(className)) && (!attr || this.hasAttribute(attr))
      && (value === undefined || this.getAttribute(attr) === value);
  }
  querySelectorAll(selector: string): AuditElement[] {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string): AuditElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; }
  getContext(kind: string) {
    if (this.tagName !== "CANVAS" || kind !== "2d") throw new AuditHarnessError("Only the explorer's 2D canvas is supported");
    // Animation frames are not executed. These tests exercise DOM rendering, not canvas painting.
    return {};
  }
  scrollIntoView(): void {}
  private replaceParts(parts: Part[]): void {
    for (const child of this.children) child.parentElement = null;
    this.parts = parts;
    for (const child of this.children) child.parentElement = this;
  }
}

/** Parse HTML before decoding attribute entities, as a browser does for inline handlers. */
function parseHtml(html: string): AuditElement {
  const root = new AuditElement("DOCUMENT");
  const stack = [root];
  const voidTags = new Set(["AREA", "BASE", "BR", "COL", "EMBED", "HR", "IMG", "INPUT", "LINK", "META", "PARAM", "SOURCE", "TRACK", "WBR"]);
  let at = 0;
  while (at < html.length) {
    const parent = stack[stack.length - 1];
    if (html.startsWith("<!--", at)) { const end = html.indexOf("-->", at + 4); at = end < 0 ? html.length : end + 3; continue; }
    if (/^<!/i.test(html.slice(at, at + 2))) { const end = html.indexOf(">", at); at = end < 0 ? html.length : end + 1; continue; }
    const closing = /^<\/([\w:-]+)\s*>/.exec(html.slice(at));
    if (closing) {
      const index = stack.map((el) => el.tagName).lastIndexOf(closing[1].toUpperCase());
      if (index > 0) stack.length = index;
      at += closing[0].length;
      continue;
    }
    const opening = /^<([A-Za-z][\w:-]*)/.exec(html.slice(at));
    if (!opening) {
      const end = html.indexOf("<", at + 1);
      parent.parts.push(decode(html.slice(at, end < 0 ? html.length : end)));
      at = end < 0 ? html.length : end;
      continue;
    }
    const element = new AuditElement(opening[1].toUpperCase());
    at += opening[0].length;
    let selfClosing = false;
    while (at < html.length) {
      while (/\s/.test(html[at] ?? "")) at++;
      if (html.startsWith("/>", at)) { selfClosing = true; at += 2; break; }
      if (html[at] === ">") { at++; break; }
      const name = /^[^\s=/>]+/.exec(html.slice(at));
      if (!name) { at++; continue; }
      at += name[0].length;
      while (/\s/.test(html[at] ?? "")) at++;
      let value = "";
      if (html[at] === "=") {
        at++;
        while (/\s/.test(html[at] ?? "")) at++;
        const quote = html[at];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, at + 1);
          value = html.slice(at + 1, end < 0 ? html.length : end);
          at = end < 0 ? html.length : end + 1;
        } else {
          value = /^[^\s>]+/.exec(html.slice(at))?.[0] ?? "";
          at += value.length;
        }
      }
      if (!element.hasAttribute(name[0])) element.setAttribute(name[0], decode(value));
    }
    parent.appendChild(element);
    if (element.tagName === "SCRIPT" || element.tagName === "STYLE") {
      const end = new RegExp(`</${element.tagName}\\s*>`, "i").exec(html.slice(at));
      element.parts.push(html.slice(at, end ? at + end.index : html.length));
      at = end ? at + end.index + end[0].length : html.length;
    } else if (!selfClosing && !voidTags.has(element.tagName)) stack.push(element);
  }
  return root;
}

export interface AuditGraphNode {
  id: string;
  name: string;
  kind: string;
  summary: string;
  parent_id: string | null;
  status: string;
  edge_count?: number;
  /** The server serializes this for every node (null when unset). */
  epistemic_status?: string | null;
  valid_until?: string | null;
  expired?: boolean;
  removed_at?: string | null;
}
export interface AuditGraph {
  nodes: AuditGraphNode[];
  edges: Array<{ from: string; to: string; relation: string; description?: string | null }>;
}
export interface AuditDomRequest { url: string; method: string; body?: string }
export interface AuditDomReply { body: unknown; status?: number }

export function graphNode(id: string, overrides: Partial<AuditGraphNode> = {}): AuditGraphNode {
  return { id, name: id, kind: "feature", summary: `Fixture ${id}`, parent_id: null, status: "active", ...overrides };
}

export async function auditDom(options: {
  graph?: AuditGraph;
  reply?: (request: AuditDomRequest) => AuditDomReply | undefined | Promise<AuditDomReply | undefined>;
} = {}) {
  const htmlUrl = new URL("../../../web/index.html", import.meta.url);
  // Resolve from helpers/ to repository root; no external scripts are loaded.
  const documentRoot = parseHtml(fs.readFileSync(htmlUrl, "utf8"));
  const body = documentRoot.querySelector("body");
  if (!body) throw new AuditHarnessError("Explorer HTML has no body");
  const graph = options.graph ?? { nodes: [], edges: [] };
  const requests: AuditDomRequest[] = [];
  const pending = new Set<Promise<unknown>>();
  const errors: string[] = [];
  const alerts: string[] = [];
  const storage = new Map<string, string>();
  const timers = new Map<number, unknown>();
  let nextTimer = 0;
  const schedule = (callback: unknown) => { timers.set(++nextTimer, callback); return nextTimer; };
  const eventSources: FakeEventSource[] = [];
  class FakeEventSource {
    onmessage: ((event: { data: string }) => void) | null = null;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(readonly url: string) {
      if (url !== "/api/events") throw new AuditHarnessError(`Unexpected EventSource URL: ${url}`);
      eventSources.push(this);
    }
    close() { this.closed = true; }
  }
  const location = { href: "http://audit.invalid/", reloads: 0, reload() { this.reloads++; } };
  const document = {
    body, documentElement: documentRoot.querySelector("html"),
    getElementById: (id: string) => documentRoot.querySelector(`#${id}`),
    querySelector: (selector: string) => documentRoot.querySelector(selector),
    querySelectorAll: (selector: string) => documentRoot.querySelectorAll(selector),
    createElement: (tag: string) => new AuditElement(tag.toUpperCase()),
    addEventListener: documentRoot.addEventListener.bind(documentRoot),
    removeEventListener: documentRoot.removeEventListener.bind(documentRoot),
  };
  const context = vm.createContext({
    document, Element: AuditElement, URL, URLSearchParams, AbortController, location, EventSource: FakeEventSource,
    console: { log() {}, warn: (...args: unknown[]) => errors.push(args.map(String).join(" ")), error: (...args: unknown[]) => errors.push(args.map(String).join(" ")) },
    alert: (message: unknown) => alerts.push(String(message)),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    performance: { now: () => 100 }, devicePixelRatio: 1,
    setTimeout: schedule, setInterval: schedule, requestAnimationFrame: schedule,
    clearTimeout: (id: number) => timers.delete(id), clearInterval: (id: number) => timers.delete(id), cancelAnimationFrame: (id: number) => timers.delete(id),
    addEventListener() {}, removeEventListener() {},
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const operation = (async () => {
        if (!url.startsWith("/api/")) throw new AuditHarnessError(`External fetch is forbidden in audit DOM: ${url}`);
        const request = { url, method: init.method ?? "GET", body: init.body };
        requests.push(request);
        const defaults: Record<string, unknown> = {
          "/api/graph": graph,
          "/api/stats": { nodes: graph.nodes.length, edges: graph.edges.length, kinds: {} },
          "/api/health": { fts: { in_sync: true }, vectors: { have: 0, total: 0 }, digests: { count: 0, stale: 0 }, empty_ids: 0, orphan_edges: 0 },
          "/api/timeline/bounds": { first: null, last: null, count: 0 },
        };
        const reply = await options.reply?.(request) ?? (Object.hasOwn(defaults, url) ? { body: defaults[url] } :
          /^\/api\/node\/.+\/history$/.test(url) ? { body: { history: [] } } : undefined);
        if (!reply) throw new AuditHarnessError(`Missing audit DOM response: ${request.method} ${url}`);
        const status = reply.status ?? 200;
        return { status, ok: status >= 200 && status < 300, json: async () => structuredClone(reply.body), text: async () => JSON.stringify(reply.body) };
      })();
      pending.add(operation);
      operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    },
  }, { codeGeneration: { strings: false, wasm: false } });
  context.window = context;
  const run = (source: string) => new vm.Script(source, { filename: htmlUrl.pathname }).runInContext(context, { timeout: 1000 });
  // Use the shipped D3, with inert clocks, rather than replacing explorer functions.
  run(fs.readFileSync(new URL("../../../web/vendor/d3.min.js", import.meta.url), "utf8"));
  const scripts = documentRoot.querySelectorAll("script").filter((script) => !script.hasAttribute("src"));
  if (!scripts.length) throw new AuditHarnessError("Explorer HTML has no inline JavaScript");
  for (const script of scripts) await run(script.textContent);

  // A microtask/event-loop barrier, not a timing-based readiness sleep.
  async function settle() {
    do {
      await Promise.allSettled([...pending]);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } while (pending.size);
  }
  await settle();
  function element(selector: string): AuditElement {
    const found = documentRoot.querySelector(selector);
    if (!found) throw new AuditHarnessError(`Explorer element not found: ${selector}`);
    return found;
  }
  function dispatch(target: AuditElement, type: string, extra: Record<string, unknown> = {}) {
    let stopped = false;
    let defaultPrevented = false;
    const event = { type, target, currentTarget: target, preventDefault() { defaultPrevented = true; }, stopPropagation() { stopped = true; }, ...extra };
    for (let current: AuditElement | null = target; current && !stopped; current = current.parentElement) {
      event.currentTarget = current;
      const property = type === "click" ? current.onclick : type === "change" ? current.onchange : null;
      if (property) property.call(current, event);
      const handler = current.getAttribute(`on${type}`);
      if (handler !== null) {
        context.__auditTarget = current;
        context.__auditEvent = event;
        try { run(`(function(event) {\n${handler}\n}).call(__auditTarget, __auditEvent)`); }
        finally { delete context.__auditTarget; delete context.__auditEvent; }
      }
      for (const listener of current.listeners.get(type) ?? []) listener.call(current, event);
    }
    if (type === "click" && !defaultPrevented) {
      const href = target.closest("a")?.getAttribute("href");
      if (href) location.href = new URL(href, location.href).href;
    }
  }
  async function invoke(name: string, ...args: unknown[]) {
    if (!/^[A-Za-z]\w*$/.test(name)) throw new AuditHarnessError("Invalid UI function name");
    context.__auditArgs = args;
    try { await run(`${name}(...__auditArgs)`); } finally { delete context.__auditArgs; }
    await settle();
  }
  function handlerErrors(root: AuditElement) {
    const result: Array<{ tag: string; attribute: string; handler: string; error: string }> = [];
    for (const current of [root, ...root.querySelectorAll("[onclick]"), ...root.querySelectorAll("[onchange]")]) {
      for (const [attribute, handler] of current.attributes) {
        if (!attribute.startsWith("on")) continue;
        try { new vm.Script(`(function(event) {\n${handler}\n})`); }
        catch (error) { result.push({ tag: current.tagName, attribute, handler, error: String(error) }); }
      }
    }
    return result;
  }
  function sse(message: unknown, reconnect = false) {
    const source = eventSources[eventSources.length - 1];
    if (!source || source.closed || !source.onmessage) throw new AuditHarnessError("Explorer has no live SSE listener");
    if (reconnect) source.onerror?.();
    source.onopen?.();
    source.onmessage({ data: JSON.stringify(message) });
  }
  return {
    element, dispatch, invoke, settle, handlerErrors, sse, requests, errors, alerts, location,
    /** Выполнить выражение в контексте обозревателя — для проверки/подготовки
     * состояния, до которого нет DOM-доступа (камера: zoom/panX/panY). */
    evaluate: <T>(expression: string): T => run(expression) as T,
    graphState: () => JSON.parse(run("JSON.stringify({nodes, edges, camera: {zoom, panX, panY, width, height}})")) as {
      nodes: Array<AuditGraphNode & { x: number; y: number; selected: boolean }>;
      edges: Array<{ source: string | { id: string }; target: string | { id: string }; relation: string; isParentEdge: boolean }>;
      camera: { zoom: number; panX: number; panY: number; width: number; height: number };
    },
    close: () => { eventSources.forEach((source) => source.close()); timers.clear(); },
  };
}

export type AuditDom = Awaited<ReturnType<typeof auditDom>>;
