import { buildTelemetryReport, formatTelemetryReport } from "./telemetry-report.js";

/**
 * `megamemory telemetry-report [--file PATH] [--tariff-version VER] [--json]`
 *
 * J1 (план 20+21 v3 §15): локальный агрегатор поверх J0-телеметрии.
 * Читает ТОЛЬКО локальный JSONL-журнал (никакой БД, никакой сети); БД не
 * открывается и не мигрирует. Путь по умолчанию — MEGAMEMORY_TELEMETRY_PATH.
 * Провайдерский usage/деньги — только реально переданные клиентом данные,
 * иначе явный unavailable; оценочные байты — отдельные поля. Правильность —
 * только заранее зафиксированный oracle (j2-experiment-design).
 */
export async function runTelemetryReport(args: string[]): Promise<void> {
  const fileIdx = args.indexOf("--file");
  const envPath = process.env["MEGAMEMORY_TELEMETRY_PATH"];
  const file = fileIdx !== -1 ? args[fileIdx + 1] : envPath;
  if (!file) {
    console.error(
      "telemetry-report: укажи --file PATH или задай MEGAMEMORY_TELEMETRY_PATH — журнал телеметрии opt-in и по умолчанию выключен."
    );
    process.exit(1);
  }
  const tariffIdx = args.indexOf("--tariff-version");
  const tariff = tariffIdx !== -1 ? args[tariffIdx + 1] : undefined;
  const asJson = args.includes("--json");

  let content: string;
  try {
    content = (await import("node:fs")).readFileSync(file, "utf8");
  } catch (err) {
    console.error(
      `telemetry-report: журнал недоступен: ${file} (${err instanceof Error ? err.message : String(err)})`
    );
    process.exit(1);
  }

  const report = buildTelemetryReport(content.split("\n"), { ...(tariff !== undefined ? { tariff_version: tariff } : {}) });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatTelemetryReport(report)) console.log(line);
  }
}
