import fs from "node:fs";
import path from "node:path";

/**
 * M2 B2 (план 20+21 v3 §7): политика expiry для kind=journal.
 *
 * Порядок значения срока автопростановки: явный valid_until (клиент) →
 * env MEGAMEMORY_EXPIRY_JOURNAL_DAYS → конфиг expiry.journal_days рядом с БД
 * (megamemory.config.json — та же дисциплина, что provenance-флаги) →
 * default 90 дней. 90 дней — стартовый настраиваемый fallback исходника
 * плана, НЕ результат измерения и не обещание достоверности; смена default —
 * отдельное решение после пилота.
 *
 * Конфиг/env читаются свежими на каждую операцию, один раз; результат и
 * effective expiry используются последовательно во всей транзакции.
 * Невалидный конфиг/env — явная ошибка ДО записи (не молчаливое отключение):
 * проверяется целое конечное неотрицательное число, переполнение вычисляемой
 * даты — тоже ошибка. Проверка ленивая: политика валидируется операцией,
 * которая её применяет (создание journal / явная смена kind на journal);
 * запись обычных kinds и явные сроки не зависят от невалидной переменной.
 */

export const JOURNAL_EXPIRY_DAYS_DEFAULT = 90;

/** Максимальное значение Date в миллисекундах (±8.64e15, ECMA-262). */
const MAX_EPOCH_MS = 8.64e15;

export interface JournalExpiryConfig {
  journalDays: number;
  /** Откуда взято значение — для диагностики и тестов приоритета. */
  source: "env" | "config" | "default";
}

export function configFileFor(dbPath: string): string {
  return path.join(path.dirname(path.resolve(dbPath)), "megamemory.config.json");
}

/**
 * Целое конечное неотрицательное число, записанное десятичными цифрами.
 * «1e3» — число и целое, но не литерал; дроби, знаки и пустота отклоняются:
 * неоднозначное значение в политике срока хуже явного отказа.
 */
function parseJournalDays(raw: string, origin: string): number {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `${origin}: "${raw}" не является целым неотрицательным числом дней. ` +
        `Нужны десятичные цифры (напр. "30"); 0 отключает автопростановку срока.`
    );
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new Error(`${origin}: "${raw}" — не конечное число.`);
  }
  return value;
}

function readConfigJournalDays(dbPath: string): { days: number; source: "config" } | null {
  const file = configFileFor(dbPath);
  let parsed: unknown;
  try {
    if (!fs.existsSync(file)) return null;
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(
      `Конфиг "${file}" не читается как JSON: ${err instanceof Error ? err.message : String(err)}. ` +
        `Почини файл — политика срока journal не применяется по молчаливому умолчанию.`
    );
  }
  const expiry = (parsed as { expiry?: unknown } | null)?.expiry;
  if (expiry === undefined) return null;
  const days = (expiry as { journal_days?: unknown } | null)?.journal_days;
  if (days === undefined) return null;
  if (typeof days !== "number" && typeof days !== "string") {
    throw new Error(
      `Конфиг "${file}": expiry.journal_days должен быть целым неотрицательным числом, получено ${JSON.stringify(days)}.`
    );
  }
  return {
    days: parseJournalDays(
      typeof days === "number" ? String(days) : days,
      `Конфиг "${file}": expiry.journal_days`
    ),
    source: "config",
  };
}

/**
 * Прочитать политику свежей для операции: env → конфиг рядом с БД → default.
 * Бросает явную ошибку на невалидном значении — до записи.
 */
export function readExpiryConfig(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env
): JournalExpiryConfig {
  const envRaw = env.MEGAMEMORY_EXPIRY_JOURNAL_DAYS;
  if (envRaw !== undefined) {
    return { journalDays: parseJournalDays(envRaw, "MEGAMEMORY_EXPIRY_JOURNAL_DAYS"), source: "env" };
  }
  const fromConfig = readConfigJournalDays(dbPath);
  if (fromConfig) return { journalDays: fromConfig.days, source: "config" };
  return { journalDays: JOURNAL_EXPIRY_DAYS_DEFAULT, source: "default" };
}

/**
 * Точная дата автопростановки: now UTC + journalDays дней, ISO-8601 UTC.
 * journalDays = 0 автопростановку выключает (возвращает null) — запись при
 * этом не объявляется безопасной, диагностика остаётся у вызывающего.
 * Переполнение вычисляемой даты — ошибка, не молчаливая бесконечность.
 */
export function journalDefaultExpiry(config: JournalExpiryConfig, now: Date): string | null {
  if (config.journalDays === 0) return null;
  const target = now.getTime() + config.journalDays * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(target) || Math.abs(target) > MAX_EPOCH_MS) {
    throw new Error(
      `expiry.journal_days = ${config.journalDays}: вычисленная дата срока переполняет диапазон Date. ` +
        `Задай разумное число дней.`
    );
  }
  return new Date(target).toISOString();
}
