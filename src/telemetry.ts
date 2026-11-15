/**
 * J0 (план 20+21 v3 §15): сбор и нормализация локальной телеметрии.
 *
 * Opt-in ЛОКАЛЬНЫЙ append-only JSONL-файл — не БД (схема 14 не меняется,
 * никаких новых таблиц/колонок). Выключено по умолчанию; включение — явный
 * env MEGAMEMORY_TELEMETRY_PATH (путь к файлу журнала). Локальные журналы
 * никуда не отправляются; ротации нет — файл растёт, владелец чистит
 * (docs/telemetry.md).
 *
 * Обёртка на уровне диспетчеризации инструментов (wrapToolHandler +
 * регистрация в index.ts), не в каждом инструменте: на каждый вызов
 * MCP-инструмента — одно событие: инструмент, исход (ok/no-op/error),
 * категория записи (если известна структурно), объём сериализованного
 * ответа, latency, ref-строки must_read, выданные узлы (ids/статусы),
 * факты открытия карточек/подтверждений/записей, provider_usage — сейчас
 * недоступен и помечен явно.
 *
 * Честность и приватность (J0 + §4.3):
 * - отсутствующие поля помечены unavailable; получение текста не помечается
 *   как понимание;
 * - payload'ы целиком не пишутся — только метаданные; секреты зачищаются
 *   известными паттернами (значения ключей/токенов не попадают в файл);
 * - при выключении — ноль накладных: disabled logger не сериализует и не
 *   парсит ответ;
 * - при включении запись синхронная (appendFileSync), дешёвая сериализация;
 *   ошибка записи журнала никогда не ломает вызов инструмента.
 */

import fs from "fs";
import path from "path";

/** Переменная окружения, включающая телеметрию (путь к JSONL-файлу). */
export const TELEMETRY_ENV = "MEGAMEMORY_TELEMETRY_PATH";

/** Версия формата события: изменение набора полей увеличивает число. */
const EVENT_FORMAT_VERSION = 1;

export type TelemetryOutcome = "ok" | "no-op" | "error";

/** Категория записи — те же группы, что и в health-метриках (§6.A2.3). */
export type TelemetryWriteCategory = "knowledge" | "confirmation" | "maintenance" | "no-op" | "unknown";

export interface TelemetryInput {
  tool: string;
  outcome: TelemetryOutcome;
  latencyMs: number;
  /** Ответ MCP-обработчика (объект) или null при брошенной ошибке. */
  response: unknown;
  /** Сообщение брошенной ошибки / isError-ответа (пишется зачищенным). */
  errorMessage?: string;
}

export interface TelemetryEvent {
  v: number;
  ts: string;
  tool: string;
  outcome: TelemetryOutcome;
  write_category: TelemetryWriteCategory | null;
  /** true — категория записи неизвестна структурно (unavailable). */
  write_category_unavailable?: boolean;
  response_bytes: number | "unavailable";
  latency_ms: number;
  /** Ref-строки must_read из ответа understand; unavailable, если не было. */
  must_read_refs?: string[] | "unavailable";
  /** Выданные узлы: ids/статусы, как они известны серверу. */
  issued_nodes?: Array<{ id: string; status: string }> | "unavailable";
  /** Факты вызова: открытие карточек / подтверждения / записи. */
  facts?: { cards_opened?: number; confirmations?: number; writes?: number };
  /** Provider usage сервер недоступен — клиент может передать позже (J1). */
  provider_usage: "unavailable";
  /** Сообщение ошибки (зачищено); только для исхода error. */
  error?: string;
}

// ---- инструменты, у которых исход записи известен структурно ----

const KNOWLEDGE_TOOLS = new Set(["create_concept", "update_concept", "link"]);
const CONFIRMATION_TOOLS = new Set(["confirm_supports"]);
const MAINTENANCE_TOOLS = new Set([
  "remove_concept",
  "check_artifacts",
  "resolve_conflict",
  "trail_save",
  "trail_refresh",
  "trail_extend",
  "slot_set",
  "slot_release",
  "task_add",
  "task_done",
]);

interface ParsedResponse {
  id?: unknown;
  decision_id?: unknown;
  duplicate_of?: unknown;
  status?: unknown;
  epistemic_status?: unknown;
  compact?: unknown;
  matches?: unknown;
  next?: unknown;
}

function parseResponseText(response: unknown): ParsedResponse | null {
  const content = (response as { content?: Array<{ type?: unknown; text?: unknown }> })?.content;
  if (!Array.isArray(content)) return null;
  const first = content[0];
  if (!first || typeof first.text !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(first.text);
    return typeof parsed === "object" && parsed !== null ? (parsed as ParsedResponse) : null;
  } catch {
    // MEGAMEMORY_ERROR-текст и прочий не-JSON: метрики ответа недоступны.
    return null;
  }
}

// ---- фильтрация секретов ----

/**
 * Простая зачистка известных паттернов: значения ключей/токенов не пишутся
 * ни в каких полях события. Не претендует на полноту — поэтому payload'ы
 * целиком сюда не попадают вовсе (только метаданные).
 */
export function redactSecrets(text: string): string {
  let out = text;
  // Authorization-заголовок целиком (значение может быть «Bearer X» в две лексемы)
  out = out.replace(/((?:authorization|auth)\s*[=:]\s*).*/gi, "$1[redacted]");
  // Bearer-токены целиком
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]");
  // известные форматы токенов провайдеров/сервисов
  out = out.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, "[redacted]");
  // ключ=значение / key: value / key="value" с «секретными» именами
  out = out.replace(
    /((?:api[_-]?key|apikey|token|secret|password|passwd|credential|private[_-]?key|access[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;)}'"]+)/gi,
    (_m, prefix: string) => `${prefix}[redacted]`
  );
  return out;
}

/** Статус узла для события: epistemic_status точнее lifecycle, но оба — статус. */
function issuedStatus(node: { status?: unknown; epistemic_status?: unknown }): string {
  if (typeof node.epistemic_status === "string" && node.epistemic_status.length > 0) {
    return node.epistemic_status;
  }
  if (typeof node.status === "string" && node.status.length > 0) return node.status;
  return "unknown";
}

/**
 * Нормализация события: чистая функция — из ответа извлекаются только
 * метаданные (ids/статусы, ref-строки must_read), не тексты.
 */
export function normalizeEvent(input: TelemetryInput): TelemetryEvent {
  const parsed = parseResponseText(input.response);
  const event: TelemetryEvent = {
    v: EVENT_FORMAT_VERSION,
    ts: new Date().toISOString(),
    tool: input.tool,
    outcome: input.outcome,
    write_category: null,
    response_bytes: "unavailable",
    latency_ms: input.latencyMs,
    provider_usage: "unavailable",
  };

  if (input.outcome === "error") {
    event.error = redactSecrets(input.errorMessage ?? "unknown error");
    event.write_category_unavailable = true;
    return event;
  }

  // Объём сериализованного ответа — wire-текст в MCP-конверте.
  const content = (input.response as { content?: Array<{ text?: unknown }> })?.content;
  if (Array.isArray(content) && typeof content[0]?.text === "string") {
    event.response_bytes = Buffer.byteLength(content[0].text as string, "utf8");
  }

  const facts: NonNullable<TelemetryEvent["facts"]> = {};

  // Категория записи — структурно, по имени инструмента и исходу.
  if (input.outcome === "no-op") {
    event.write_category = "no-op";
    facts.writes = 0; // дубль/пустой update — не пополнение знаний
  } else if (KNOWLEDGE_TOOLS.has(input.tool)) {
    event.write_category = "knowledge";
  } else if (CONFIRMATION_TOOLS.has(input.tool)) {
    event.write_category = "confirmation";
  } else if (MAINTENANCE_TOOLS.has(input.tool)) {
    event.write_category = "maintenance";
  } else {
    // Неизвестно структурно — явно unavailable, не догадка.
    event.write_category_unavailable = true;
  }

  if (input.tool === "understand") {
    // Ref-строки must_read и выданные узлы — из фактического ответа.
    const mustRead = (parsed?.next as { must_read?: Array<{ ref?: unknown }> } | undefined)?.must_read;
    event.must_read_refs =
      Array.isArray(mustRead) && mustRead.some((m) => typeof m?.ref === "string")
        ? mustRead.map((m) => redactSecrets(String(m.ref)))
        : "unavailable";
    const nodes = Array.isArray(parsed?.compact)
      ? (parsed?.compact as Array<Record<string, unknown>>)
      : Array.isArray(parsed?.matches)
        ? (parsed?.matches as Array<Record<string, unknown>>)
        : null;
    event.issued_nodes = nodes
      ? nodes.map((n) => ({ id: String(n.id ?? "unknown"), status: issuedStatus(n) }))
      : "unavailable";
    facts.writes = 0;
  } else if (input.tool === "get_concept") {
    // Открытие карточки: факт вызова, НЕ доказательство понимания текста.
    facts.cards_opened = 1;
    event.issued_nodes = parsed?.id
      ? [{ id: String(parsed.id), status: issuedStatus(parsed as Record<string, unknown>) }]
      : "unavailable";
  } else if (input.tool === "confirm_supports") {
    facts.confirmations = 1;
    if (parsed?.decision_id) event.issued_nodes = [{ id: String(parsed.decision_id), status: "confirmed" }];
  } else if (input.outcome === "ok" && (KNOWLEDGE_TOOLS.has(input.tool) || MAINTENANCE_TOOLS.has(input.tool))) {
    facts.writes = 1;
    if (parsed?.id) event.issued_nodes = [{ id: String(parsed.id), status: "unknown" }];
  }

  event.facts = facts;
  return event;
}

export interface TelemetryLogger {
  enabled: boolean;
  record(input: TelemetryInput): void;
}

/**
 * Логгер телеметрии. path задан (непустая строка) — включено: каждая запись
 * — одна строка JSON, дописывается синхронно; ошибка записи/создания каталога
 * глушится (журнал не ломает вызов). path не задан — выключено: record
 * возвращает сразу, ноль накладных.
 */
export function createTelemetryLogger(opts: { path?: string | null }): TelemetryLogger {
  const filePath = opts.path;
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { enabled: false, record() { /* выключено — ноль накладных */ } };
  }
  return {
    enabled: true,
    record(input) {
      try {
        const event = normalizeEvent(input);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(filePath, JSON.stringify(event) + "\n", "utf-8");
      } catch {
        // Телеметрия никогда не ломает вызов инструмента.
      }
    },
  };
}

/**
 * Обёртка обработчика MCP-инструмента на уровне диспетчеризации: измеряет
 * latency, классифицирует исход (isError → error), пишет событие и возвращает
 * результат/ошибку как есть. При выключенной телеметрии — прозрачный
 * passthrough без разбора ответа.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wrapToolHandler(
  tool: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => Promise<unknown>,
  logger: TelemetryLogger
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (...args: any[]) => Promise<unknown> {
  if (!logger.enabled) {
    // Ноль накладных при выключении: один boolean-проверка на регистрации,
    // passthrough без обёртки.
    return handler;
  }
  return async (...args: unknown[]) => {
    const started = Date.now();
    try {
      const response = await handler(...args);
      const isError = Boolean((response as { isError?: unknown })?.isError);
      const text = (response as { content?: Array<{ text?: unknown }> })?.content?.[0]?.text;
      logger.record({
        tool,
        outcome: isError ? "error" : "ok",
        latencyMs: Date.now() - started,
        response,
        ...(isError && typeof text === "string" ? { errorMessage: text } : {}),
      });
      return response;
    } catch (err) {
      logger.record({
        tool,
        outcome: "error",
        latencyMs: Date.now() - started,
        response: null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
}

/** Путь телеметрии из окружения; отсутствует/пуст — выключено. */
export function telemetryPathFromEnv(): string | null {
  const raw = process.env[TELEMETRY_ENV];
  if (raw === undefined || raw.trim() === "") return null;
  return raw.trim();
}
