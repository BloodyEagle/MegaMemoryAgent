/**
 * План 26 §2 (2.11.0): верbatim-исходник по file_ref в ответе understand.
 *
 * `understand` отдаёт карточки с `file_refs`, но ни строки кода — агенту всё
 * равно нужен отдельный Read. `readRefLines` читает диапазон ссылку и кормит
 * карточку: один вызов вместо двух. Границы:
 *  - git-схемы и ссылки без локатора не читаются (`no_range`) — целый файл
 *    за агента, это уже Read, а не экономия;
 *  - путь обязан оставаться внутри root (лексически И по realpath — симлинк
 *    границу не обходят);
 *  - файл больше 1 МиБ — `too_large`; не UTF-8 или содержит `\0` — `not_text`;
 *  - диапазон шире `maxLines` режется ТОЛЬКО хвостом (`truncated: true`),
 *    середина не вырезается.
 */

import fs from "node:fs";
import path from "node:path";
import { parseRef } from "./refs.js";

export type SourceSkipReason =
  | "no_range"
  | "outside_root"
  | "missing"
  | "too_large"
  | "not_text";

export interface ReadRefLinesOk {
  ok: true;
  /** Путь, как записал агент (локатор снят). */
  path: string;
  /** 1-based номер первой строки выдачи. */
  start_line: number;
  lines: string[];
  /** true, если хвост диапазона или ширины не поместился. */
  truncated: boolean;
}

export interface ReadRefLinesErr {
  ok: false;
  reason: SourceSkipReason;
}

const MAX_FILE_BYTES = 1024 * 1024;

function escapesRoot(rooted: string, candidate: string): boolean {
  const rel = path.relative(rooted, candidate);
  return rel === "" || rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel);
}

/**
 * Прочитать диапазон строк из файловой ссылки. `ref` — дословный file_ref
 * узла (`src/x.ts:10-20`, `src/x.ts#L10-L20`); `root` — корень проекта
 * (cwd сервера); `maxLines` — потолок строк выдачи.
 */
export function readRefLines(
  root: string,
  ref: string,
  maxLines: number
): ReadRefLinesOk | ReadRefLinesErr {
  const parsed = parseRef(ref);
  if (parsed.kind !== "file" || parsed.locator === null) return { ok: false, reason: "no_range" };

  const [startRaw, endRaw] = parsed.locator.split("-");
  const start = Number.parseInt(startRaw, 10);
  const end = endRaw !== undefined ? Number.parseInt(endRaw, 10) : start;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    return { ok: false, reason: "no_range" };
  }

  const rootResolved = path.resolve(root);
  let rootReal = rootResolved;
  try {
    rootReal = fs.realpathSync(rootResolved);
  } catch {
    // Несуществующий корень: ниже realpath файла тоже не разрешится — missing.
  }

  const abs = path.resolve(rootResolved, parsed.path);
  if (escapesRoot(rootResolved, abs)) return { ok: false, reason: "outside_root" };

  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { ok: false, reason: "missing" };
  }
  // Симлинк не обходит границу: разрешённый путь проверяется по realpath корня.
  if (escapesRoot(rootReal, real)) return { ok: false, reason: "outside_root" };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!stat.isFile()) return { ok: false, reason: "missing" };
  if (stat.size > MAX_FILE_BYTES) return { ok: false, reason: "too_large" };

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(real);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (buffer.includes(0)) return { ok: false, reason: "not_text" };

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return { ok: false, reason: "not_text" };
  }
  if (text.startsWith("﻿")) text = text.slice(1);
  const normalized = text.replace(/\r\n?/g, "\n");
  const allLines = normalized.split("\n");
  // Файл с завершающим переводом строки не содержит лишней пустой строки.
  if (allLines.length > 0 && allLines[allLines.length - 1] === "" && normalized.endsWith("\n")) {
    allLines.pop();
  }

  if (start > allLines.length) return { ok: false, reason: "missing" };
  const endCapped = Math.min(end, allLines.length);
  const lines = allLines.slice(start - 1, endCapped);
  const overMax = lines.length > maxLines;
  return {
    ok: true,
    path: parsed.path,
    start_line: start,
    ...(overMax ? { lines: lines.slice(0, maxLines) } : { lines }),
    truncated: overMax || end < endCapped ? true : false,
  };
}
