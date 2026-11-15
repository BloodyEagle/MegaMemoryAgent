/**
 * P2.2 (план 20+21 v3 §11): МИНИМАЛЬНЫЙ adapter к структурному инструменту
 * token-economy-ts — пилот.
 *
 * Ключевые решения:
 * - Adapter — узкий потребитель структурных результатов (seam 5 плана): MegaMemory
 *   НЕ копирует парсер и НЕ строит второй индекс исходников. Единственные
 *   операции пилота: op=info (capability-детект), op=symbol (разрешение
 *   определения), op=rdeps (зависимые по import-графу, для обхода зависимостей).
 * - Конфиг-точка опциональна: явный параметр вызова (adapter.graph_tool) либо env
 *   MEGAMEMORY_CODE_ADAPTER (путь к каталогу scripts скилла или к graph-tool.js).
 *   Автодоиска нет: вызов чужого кода — явное решение вызывающего.
 * - Capability-детект: op=info должен ответить валидным JSON с projectType;
 *   нет ответа / старый скилл без нужных полей → adapter недоступен, проверка
 *   деградирует до файлового уровня ЯВНО (report.adapter), не молча.
 * - Вызов процессом spawn с массивом аргументов (без shell-строки и
 *   интерполяции), таймаут, изоляция cwd = корень анализируемого repo.
 * - Локатор символа: repo, путь, имя/владелец; номера строк — ТЕКУЩИЙ результат
 *   разрешения, не постоянная идентичность. Неоднозначное/пропавшее определение
 *   → явный ambiguous/missing, требует чтения; выбор первого совпадения запрещён.
 * - Консервативная семантика изменения: символ считается изменившимся, если
 *   изменился его файл/диапазон (по данным adapter); остальное — file-level.
 *   Статическая полнота — только объявленный scope adapter; тестовые файлы
 *   входят, когда вывод опирается на тесты: default-исключения не маскируются,
 *   scope едут в отчёте явно.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  CodeAdapterCapability,
  CodeAdapterConfig,
} from "./types.js";

export const DEFAULT_ADAPTER_TIMEOUT_MS = 10_000;

/** Верхняя граница чтения stdout adapter (защита от чужого маргинального вывода). */
const ADAPTER_MAX_BUFFER = 4 * 1024 * 1024;

export const ADAPTER_ENV_VAR = "MEGAMEMORY_CODE_ADAPTER";

/**
 * Разрешить конфиг adapter: явный параметр вызова → env. Путь может указывать
 * на каталог scripts скилла или непосредственно на graph-tool.js. null —
 * adapter не сконфигурирован (пилот: автодоиска нет, это честный файловый
 * режим, а не дефект).
 */
export function resolveAdapterConfig(
  input?: { graph_tool?: string },
  repoRoot?: string
): CodeAdapterConfig | null {
  const raw = input?.graph_tool?.trim() || process.env[ADAPTER_ENV_VAR]?.trim() || "";
  if (!raw) return null;
  let script = raw;
  try {
    const stat = fs.statSync(raw);
    if (stat.isDirectory()) script = path.join(raw, "graph-tool.js");
    else if (path.basename(raw) === "graph-tool.js") script = raw;
    else script = path.join(raw, "graph-tool.js");
  } catch {
    // Не существует — capability-детект честно сообщит недоступность.
    script = raw;
  }
  return {
    graph_tool: script,
    repo_root: repoRoot ?? process.cwd(),
    timeout_ms: DEFAULT_ADAPTER_TIMEOUT_MS,
    source: input?.graph_tool?.trim() ? "param" : "env",
  };
}

/**
 * VERSION скилла лежит рядом с каталогом scripts (../VERSION). Лучшие усилия:
 * нет файла — версия null, capability определяется по ответу op=info.
 */
export function adapterVersion(cfg: CodeAdapterConfig): string | null {
  try {
    const versionFile = path.join(path.dirname(cfg.graph_tool), "..", "VERSION");
    const raw = fs.readFileSync(versionFile, "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Один вызов adapter: spawn с массивом аргументов (НЕ shell-строка), таймаут,
 * изоляция cwd, ограниченный stdout. Возвращает разобранный JSON или ошибку.
 */
function runAdapter(
  cfg: CodeAdapterConfig,
  args: string[]
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [cfg.graph_tool, ...args], {
        cwd: cfg.repo_root,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (r: { ok: true; data: unknown } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill();
      done({ ok: false, error: `adapter timed out after ${cfg.timeout_ms}ms` });
    }, cfg.timeout_ms);
    child.stdout?.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > ADAPTER_MAX_BUFFER) {
        child.kill();
        done({ ok: false, error: "adapter output exceeded the buffer" });
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.resume();
    child.on("error", (err) => done({ ok: false, error: err.message }));
    child.on("close", (code) => {
      const out = Buffer.concat(chunks).toString("utf8");
      if (code !== 0) {
        done({ ok: false, error: `adapter exited with ${code ?? "null"}` });
        return;
      }
      try {
        done({ ok: true, data: JSON.parse(out) });
      } catch {
        done({ ok: false, error: "adapter returned non-JSON output" });
      }
    });
  });
}

/**
 * Capability-детект: op=info должен ответить JSON с projectType. Отсутствие
 * adapter/старый скрипт/мусорный вывод → available: false и причина —
 * файловый режим ЯВНО, не молча.
 */
export async function detectAdapterCapability(
  cfg: CodeAdapterConfig
): Promise<CodeAdapterCapability> {
  const version = adapterVersion(cfg);
  const result = await runAdapter(cfg, ["op=info"]);
  if (!result.ok) {
    return { available: false, project_type: null, version, reason: result.error };
  }
  const data = result.data as { projectType?: unknown };
  if (!data || typeof data !== "object" || typeof data.projectType !== "string") {
    return {
      available: false,
      project_type: null,
      version,
      reason: "op=info ответил без projectType — версия adapter не поддерживает нужные операции",
    };
  }
  return { available: true, project_type: data.projectType, version, reason: null };
}

/** Разрешённое определение из op=symbol: текущий результат, не идентичность. */
export interface AdapterSymbolCandidate {
  file: string;
  kind?: string;
  owner?: string;
  line?: number;
  start_line?: number;
  end_line?: number;
  body_start_line?: number;
  body_end_line?: number;
}

export type AdapterSymbolOutcome =
  | { status: "unique"; candidate: AdapterSymbolCandidate }
  | { status: "ambiguous"; candidates: AdapterSymbolCandidate[] }
  | { status: "missing" }
  | { status: "adapter_error"; error: string };

/**
 * op=symbol: разрешить имя символа. Локатор может нести file — данные для
 * проверки однозначности: ровно один кандидат на этом файле снимает
 * неоднозначность. Никаких «первых совпадений».
 */
export async function adapterResolveSymbol(
  cfg: CodeAdapterConfig,
  locator: { name: string; in?: string; file?: string }
): Promise<AdapterSymbolOutcome> {
  const args = ["op=symbol", `name=${locator.name}`];
  if (locator.in) args.push(`in=${locator.in}`);
  const result = await runAdapter(cfg, args);
  if (!result.ok) return { status: "adapter_error", error: result.error };
  const data = result.data as { definedIn?: unknown };
  if (!data || typeof data !== "object" || !Array.isArray(data.definedIn)) {
    return { status: "adapter_error", error: "op=symbol ответил без definedIn" };
  }
  const candidates: AdapterSymbolCandidate[] = [];
  for (const raw of data.definedIn) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.file !== "string") continue;
    candidates.push({
      file: e.file,
      ...(typeof e.kind === "string" ? { kind: e.kind } : {}),
      ...(typeof e.owner === "string" ? { owner: e.owner } : {}),
      ...(typeof e.line === "number" ? { line: e.line } : {}),
      ...(typeof e.startLine === "number" ? { start_line: e.startLine } : {}),
      ...(typeof e.endLine === "number" ? { end_line: e.endLine } : {}),
      ...(typeof e.bodyStartLine === "number" ? { body_start_line: e.bodyStartLine } : {}),
      ...(typeof e.bodyEndLine === "number" ? { body_end_line: e.bodyEndLine } : {}),
    });
  }
  if (candidates.length === 0) return { status: "missing" };
  if (candidates.length > 1) {
    // Локатор несёт данные для проверки однозначности: file сужает до одного.
    if (locator.file) {
      const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
      const matching = candidates.filter((c) => norm(c.file) === norm(locator.file!));
      if (matching.length === 1) {
        return {
          status: "unique",
          candidate: matching[0],
          // note неоднозначности едет наружу через отчёт — candidates сохранены.
        } as AdapterSymbolOutcome;
      }
    }
    return { status: "ambiguous", candidates };
  }
  return { status: "unique", candidate: candidates[0] };
}

/** Результат op=rdeps: зависимые файлы и объявленная полнота static scope. */
export interface AdapterRdepsOutcome {
  dependents: string[];
  total: number | null;
  complete: boolean;
  scan_root: string | null;
  error: string | null;
}

/**
 * op=rdeps по файлу: уровень 1 import-графа. Обход остаётся ограниченным
 * (пилот не строит транзитивное замыкание), корректен на циклах — зависимостей
 * уровня 1 не может быть бесконечно, цикл A→B→A вернёт A в importedBy B один раз.
 */
export async function adapterRdepsOfFile(
  cfg: CodeAdapterConfig,
  file: string
): Promise<AdapterRdepsOutcome> {
  const result = await runAdapter(cfg, ["op=rdeps", `file=${file}`]);
  if (!result.ok) {
    return { dependents: [], total: null, complete: false, scan_root: null, error: result.error };
  }
  const data = result.data as {
    importedBy?: unknown;
    importedByTotal?: unknown;
    completeness?: unknown;
    scope?: unknown;
    error?: unknown;
  };
  if (!data || typeof data !== "object" || data.error != null) {
    const err = data && typeof data.error === "string" ? data.error : "op=rdeps ответил без importedBy";
    return { dependents: [], total: null, complete: false, scan_root: null, error: err };
  }
  const dependents: string[] = [];
  if (Array.isArray(data.importedBy)) {
    for (const raw of data.importedBy) {
      if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).file === "string") {
        dependents.push((raw as Record<string, string>).file);
      }
    }
  }
  const scopeRoot = data.scope as { scanRoot?: unknown } | undefined;
  return {
    dependents,
    total: typeof data.importedByTotal === "number" ? data.importedByTotal : dependents.length,
    complete:
      (!data.completeness || (data.completeness as { complete?: unknown }).complete !== false) &&
      (typeof data.importedByTotal !== "number" || data.importedByTotal === dependents.length),
    scan_root:
      scopeRoot && typeof scopeRoot.scanRoot === "string" ? scopeRoot.scanRoot : null,
    error: null,
  };
}
