/**
 * J0 (план 20+21 v3 §15): локальная телеметрия — opt-in JSONL-файл, БЕЗ
 * изменения схемы БД и без записей в БД.
 *
 * Контракт:
 * - выключено по умолчанию; включение — явный env MEGAMEMORY_TELEMETRY_PATH;
 * - события на вызов MCP-инструмента: инструмент, исход (ok/no-op/error),
 *   категория записи (знание/подтверждение/обслуживание/no-op/unknown,
 *   если известна), объём сериализованного ответа, latency, ref-строки
 *   must_read, выданные узлы (ids/статусы), факты открытия/подтверждений/
 *   записей, provider_usage — сейчас unavailable;
 * - отсутствующие поля помечены unavailable; получение текста не помечается
 *   как понимание;
 * - секреты фильтруются; payload'ы целиком не пишутся — только метаданные;
 * - при выключении — ноль накладных (logger.disabled не парсит и не пишет);
 * - локальный append-only файл, никуда не отправляется, ротации нет.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TELEMETRY_ENV,
  createTelemetryLogger,
  wrapToolHandler,
  normalizeEvent,
  redactSecrets,
} from "../telemetry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-telemetry-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readLines(file: string): Array<Record<string, unknown>> {
  const text = fs.readFileSync(file, "utf-8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("telemetry: включено — события пишутся и нормализуются", () => {
  it("env задаёт путь; каждый record — одна JSONL-строка с обязательными полями", () => {
    const file = path.join(tmpDir, "tel.jsonl");
    const logger = createTelemetryLogger({ path: file });
    expect(logger.enabled).toBe(true);
    logger.record({
      tool: "get_concept",
      outcome: "ok",
      latencyMs: 5,
      response: { content: [{ type: "text", text: JSON.stringify({ id: "a", status: "active" }) }] },
    });
    const lines = readLines(file);
    expect(lines.length).toBe(1);
    const ev = lines[0];
    expect(ev.v).toBe(1);
    expect(ev.tool).toBe("get_concept");
    expect(ev.outcome).toBe("ok");
    expect(ev.latency_ms).toBe(5);
    // Provider usage сейчас недоступен — поле есть и честно помечено.
    expect(ev.provider_usage).toBe("unavailable");
    expect(typeof ev.ts).toBe("string");
  });

  it("файл растёт дописыванием (append-only), ротации нет", () => {
    const file = path.join(tmpDir, "tel.jsonl");
    const logger = createTelemetryLogger({ path: file });
    logger.record({ tool: "understand", outcome: "ok", latencyMs: 1, response: null });
    logger.record({ tool: "board", outcome: "ok", latencyMs: 2, response: null });
    expect(readLines(file).length).toBe(2);
  });
});

describe("telemetry: выключено — ни файла, ни записей, ноль накладных", () => {
  it("без env logger disabled: record ничего не пишет и не создаёт файл", () => {
    const logger = createTelemetryLogger({});
    expect(logger.enabled).toBe(false);
    expect(TELEMETRY_ENV).toBe("MEGAMEMORY_TELEMETRY_PATH");
    logger.record({
      tool: "understand",
      outcome: "ok",
      latencyMs: 1,
      response: { content: [{ type: "text", text: "{}" }] },
    });
    const leftovers = fs.readdirSync(tmpDir);
    expect(leftovers.length).toBe(0);
  });

  it("пустая строка env — тоже выключено", () => {
    const logger = createTelemetryLogger({ path: "" });
    expect(logger.enabled).toBe(false);
  });

  it("disabled logger не сериализует ответ (объект не тронут — ноль накладных)", () => {
    const logger = createTelemetryLogger({});
    const response = { content: [{ type: "text", text: "{}" }] };
    logger.record({ tool: "understand", outcome: "ok", latencyMs: 0, response });
    expect(response).toEqual({ content: [{ type: "text", text: "{}" }] });
  });
});

describe("telemetry: нет записей в БД", () => {
  it("модуль телеметрии не открывает и не создаёт базу", () => {
    const file = path.join(tmpDir, "tel.jsonl");
    const logger = createTelemetryLogger({ path: file });
    logger.record({ tool: "create_concept", outcome: "ok", latencyMs: 3, response: null });
    const files = fs.readdirSync(tmpDir);
    expect(files).toEqual(["tel.jsonl"]);
  });
});

describe("telemetry: ok / no-op / error различаются", () => {
  it("isError в ответе — outcome error с сообщением", () => {
    const ev = normalizeEvent({
      tool: "get_concept",
      outcome: "error",
      latencyMs: 4,
      response: {
        content: [{ type: "text", text: "MEGAMEMORY_ERROR: not found" }],
        isError: true,
      },
      errorMessage: "not found",
    });
    expect(ev.outcome).toBe("error");
    expect(ev.error).toBe("not found");
  });

  it("duplicate create — no-op и категория не «знание»", () => {
    const ev = normalizeEvent({
      tool: "create_concept",
      outcome: "no-op",
      latencyMs: 2,
      response: {
        content: [
          { type: "text", text: JSON.stringify({ duplicate_of: "existing", message: "duplicate" }) },
        ],
      },
    });
    expect(ev.outcome).toBe("no-op");
    expect(ev.write_category).toBe("no-op");
    expect(ev.facts).toMatchObject({ writes: 0 });
  });

  it("успешный create — ok и категория «знание»; confirm — «подтверждение»", () => {
    const ok = normalizeEvent({
      tool: "create_concept",
      outcome: "ok",
      latencyMs: 2,
      response: {
        content: [{ type: "text", text: JSON.stringify({ id: "n-1", message: "created" }) }],
      },
    });
    expect(ok.outcome).toBe("ok");
    expect(ok.write_category).toBe("knowledge");
    expect(ok.facts).toMatchObject({ writes: 1 });

    const conf = normalizeEvent({
      tool: "confirm_supports",
      outcome: "ok",
      latencyMs: 2,
      response: {
        content: [
          { type: "text", text: JSON.stringify({ decision_id: "d-1", confirmed: true }) },
        ],
      },
    });
    expect(conf.write_category).toBe("confirmation");
    expect(conf.facts).toMatchObject({ confirmations: 1 });
  });

  it("обслуживание и чтение: remove — maintenance; get_concept — открытие карточки", () => {
    const rm = normalizeEvent({
      tool: "remove_concept",
      outcome: "ok",
      latencyMs: 2,
      response: { content: [{ type: "text", text: "{}" }] },
    });
    expect(rm.write_category).toBe("maintenance");
    const card = normalizeEvent({
      tool: "get_concept",
      outcome: "ok",
      latencyMs: 2,
      response: {
        content: [{ type: "text", text: JSON.stringify({ id: "a", status: "active" }) }],
      },
    });
    expect(card.facts).toMatchObject({ cards_opened: 1 });
    expect(card.write_category).toBeNull();
  });

  it("неизвестный исход записи — категория unknown, не «знание»", () => {
    const ev = normalizeEvent({
      tool: "future_writer",
      outcome: "ok",
      latencyMs: 1,
      response: { content: [{ type: "text", text: "{}" }] },
    });
    // Неизвестному инструменту категория записи не присваивается: null
    // (unavailable), а не догадка «знание».
    expect(ev.write_category).toBeNull();
    expect(ev.write_category_unavailable).toBe(true);
  });
});

describe("telemetry: must_read и выданные узлы", () => {
  it("understand: ref-строки must_read и ids/статусы выданных узлов", () => {
    const response = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            compact: [
              { id: "x-1", status: "active", epistemic_status: "open" },
              { id: "y-2", status: "active" },
            ],
            next: {
              must_read: [
                { ref: "src/a.ts:1-10", why: "w", node_id: "x-1" },
              ],
            },
          }),
        },
      ],
    };
    const ev = normalizeEvent({ tool: "understand", outcome: "ok", latencyMs: 10, response });
    expect(ev.must_read_refs).toEqual(["src/a.ts:1-10"]);
    expect(ev.issued_nodes).toEqual([
      { id: "x-1", status: "open" },
      { id: "y-2", status: "active" },
    ]);
  });

  it("understand без must_read: поле недоступно, не пустой обман", () => {
    const ev = normalizeEvent({
      tool: "understand",
      outcome: "ok",
      latencyMs: 1,
      response: { content: [{ type: "text", text: "{}" }] },
    });
    expect(ev.must_read_refs).toBe("unavailable");
  });
});

describe("telemetry: фильтрация секретов", () => {
  it("значения ключей/токенов в тексте зачищаются", () => {
    expect(redactSecrets("api_key=sk-abc123def456")).toBe("api_key=[redacted]");
    expect(redactSecrets("token: ghp_16Characters0000000000")).not.toContain("ghp_16Characters0000000000");
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).toBe("Authorization: [redacted]");
    expect(redactSecrets("обычный текст src/a.ts")).toBe("обычный текст src/a.ts");
  });

  it("ошибка вызова (может эхоить параметры) попадает в журнал зачищенной", () => {
    const file = path.join(tmpDir, "tel.jsonl");
    const logger = createTelemetryLogger({ path: file });
    logger.record({
      tool: "create_concept",
      outcome: "error",
      latencyMs: 1,
      response: null,
      errorMessage: "сбой: MEGAMEMORY_TOKEN=ghp_supersecretvalue12345",
    });
    const raw = fs.readFileSync(file, "utf-8");
    expect(raw).not.toContain("ghp_supersecretvalue12345");
    expect(raw).toContain("[redacted]");
  });

  it("payload'ы целиком не пишутся: только метаданные события", () => {
    const file = path.join(tmpDir, "tel.jsonl");
    const logger = createTelemetryLogger({ path: file });
    logger.record({
      tool: "understand",
      outcome: "ok",
      latencyMs: 1,
      response: {
        content: [
          { type: "text", text: JSON.stringify({ compact: [{ id: "a" }], matches: [{ summary: "СЕКРЕТНЫЙ-ТЕКСТ-КАРТОЧКИ" }] }) },
        ],
      },
    });
    const raw = fs.readFileSync(file, "utf-8");
    expect(raw).not.toContain("СЕКРЕТНЫЙ-ТЕКСТ-КАРТОЧКИ");
    expect(raw).not.toContain('"matches"');
  });
});

describe("telemetry: объём сериализованного ответа", () => {
  it("response_bytes — размер wire-текста ответа", () => {
    const text = JSON.stringify({ id: "a" }, null, 2);
    const ev = normalizeEvent({
      tool: "get_concept",
      outcome: "ok",
      latencyMs: 1,
      response: { content: [{ type: "text", text }] },
    });
    expect(ev.response_bytes).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("у ошибочного вызова без ответа объём помечен unavailable", () => {
    const ev = normalizeEvent({
      tool: "get_concept",
      outcome: "error",
      latencyMs: 1,
      response: null,
      errorMessage: "boom",
    });
    expect(ev.response_bytes).toBe("unavailable");
  });
});

describe("telemetry: обёртка диспетчеризации", () => {
  it("wrapToolHandler: исход ok, latency измерена, ответ проходит насквозь", async () => {
    const file = path.join(tmpDir, "tel.jsonl");
    const logger = createTelemetryLogger({ path: file });
    const handler = async () => ({
      content: [{ type: "text", text: JSON.stringify({ id: "a" }) }],
    });
    const wrapped = wrapToolHandler("get_concept", handler, logger);
    const result = (await wrapped({}, undefined)) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0].text).toContain('"id"');
    const lines = readLines(file);
    expect(lines.length).toBe(1);
    expect(lines[0].tool).toBe("get_concept");
    expect(lines[0].outcome).toBe("ok");
    expect(lines[0].latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("брошенная ошибка — event error, исключение пробрасывается", async () => {
    const file = path.join(tmpDir, "tel.jsonl");
    const logger = createTelemetryLogger({ path: file });
    const wrapped = wrapToolHandler("get_concept", async () => {
      throw new Error("boom");
    }, logger);
    await expect(wrapped({}, undefined)).rejects.toThrow("boom");
    const lines = readLines(file);
    expect(lines[0].outcome).toBe("error");
  });

  it("isError-ответ — event error", async () => {
    const file = path.join(tmpDir, "tel.jsonl");
    const logger = createTelemetryLogger({ path: file });
    const wrapped = wrapToolHandler(
      "get_concept",
      async () => ({
        content: [{ type: "text", text: "MEGAMEMORY_ERROR: nope" }],
        isError: true as const,
      }),
      logger
    );
    await wrapped({}, undefined);
    const lines = readLines(file);
    expect(lines[0].outcome).toBe("error");
  });

  it("ошибка записи телеметрии не ломает вызов", async () => {
    // Путь в несуществующем каталоге: record падает молча, вызов работает.
    const badPath = path.join(tmpDir, "missing-dir", "nested", "tel.jsonl");
    const logger = createTelemetryLogger({ path: badPath });
    const wrapped = wrapToolHandler(
      "get_concept",
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      logger
    );
    const result = (await wrapped({}, undefined)) as { content: Array<{ text: string }> };
    expect(result.content[0].text).toBe("ok");
    expect(logger.enabled).toBe(true);
  });

  it("disabled logger: обёртка — прозрачный passthrough без записи", async () => {
    const logger = createTelemetryLogger({});
    const wrapped = wrapToolHandler(
      "get_concept",
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      logger
    );
    const result = (await wrapped({}, undefined)) as { content: Array<{ text: string }> };
    expect(result.content[0].text).toBe("ok");
    expect(fs.readdirSync(tmpDir).length).toBe(0);
  });
});
