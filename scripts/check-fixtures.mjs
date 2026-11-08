// План 11 (2.2.1): страж фикстур, который переживает конец процесса.
//
// repo-hygiene-тесты проверяют fixtures/ во время прогона, но мутация может
// случиться ПОСЛЕ последнего теста: нативный хендл libsql освобождается при
// GC и отложенным чекпоинтом переносит -wal в main на выходе процесса
// (воспроизведено планом 11: RW-открытие фикстуры v4 мигрировало её байты
// без единого явного запроса). Поэтому хеши и отсутствие сайдкаров
// перепроверяются posttest-скриптом — после того как все процессы завершились.
//
// Один источник истины для обеих проверок: repo-hygiene-тест вызывает этот
// скрипт (execFileSync), npm posttest — тоже. Формат строк sha256sums.txt
// толерантен к CRLF (исторический файл содержит \r\n).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "fixtures");
const SUMS = path.join(FIXTURES, "sha256sums.txt");

function readSums() {
  return fs
    .readFileSync(SUMS, "utf-8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((line) => {
      const match = /^([0-9a-f]{64}) \*?(.+?)\s*$/.exec(line.trim());
      if (!match) throw new Error(`malformed sha256sums.txt line: ${line}`);
      return { hash: match[1], file: match[2] };
    });
}

function fail(messages) {
  for (const m of messages) console.error(`fixtures-guard: ${m}`);
  console.error(
    "fixtures-guard: прогон меняет эталонные фикстуры — ищи RW-открытие " +
      "fixtures/* (чини копией во временном каталоге) или легитимное " +
      "обновление фикстуры забудет обновить sha256sums.txt."
  );
  process.exit(1);
}

const problems = [];

for (const entry of readSums()) {
  const file = path.join(ROOT, entry.file);
  if (!fs.existsSync(file)) {
    problems.push(`${entry.file}: отсутствует`);
    continue;
  }
  const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== entry.hash) {
    problems.push(`${entry.file}: хеш ${actual} != эталон ${entry.hash} — файл мутировал`);
  }
}

const listed = new Set(readSums().map((e) => path.basename(e.file)));
for (const f of fs.readdirSync(FIXTURES)) {
  if (f === "sha256sums.txt") continue;
  if (!listed.has(f)) {
    problems.push(`${f}: не внесён в sha256sums.txt (сайдкар -wal/-shm или мусор)`);
  }
}

if (problems.length > 0) fail(problems);
console.log("fixtures-guard: OK — эталонные хеши сходятся, сайдкаров нет");
