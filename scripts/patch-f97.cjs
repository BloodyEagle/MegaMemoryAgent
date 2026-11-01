// F9.7: smaller-model option in docs (not a default).
const fs = require("fs");

let fork = fs.readFileSync("docs/FORK.md", "utf8").replace(/\r\n/g, "\n");
if (!fork.includes("rubert-tiny2")) {
  const anchor = "(имя модели не содержит \"e5\").";
  const add = anchor + `

**Меньшая модель (F9.7).** Для чисто русских проектов \`cointegrated/rubert-tiny2\`
(29M параметров, 312 измерений) — в 4–5 раз меньше памяти и в 4–6 раз быстрее e5-small.
ONNX-экспорта под transformers.js может не быть — тогда требуется конвертация (отдельная задача);
префиксы \`passage:\`/\`query:\` к ней не применяются автоматически.

**Память (F9.1–F9.2).** Модель выгружается после \`MEGAMEMORY_EMBED_IDLE_MS\` простоя
(по умолчанию 5 минут, \`0\` — не выгружать), сессия ONNX создаётся без memory-арены,
потоки — \`MEGAMEMORY_EMBED_THREADS\` (по умолчанию 1). Режим \`MEGAMEMORY_SEARCH=fts\`
вообще не загружает модель. Текущее потребление — \`megamemory doctor\` и \`/api/stats → memory\`.`;
  if (!fork.includes(anchor)) { console.error("fork anchor miss"); process.exit(1); }
  fork = fork.replace(anchor, add);
  fs.writeFileSync("docs/FORK.md", fork);
  console.log("FORK.md updated");
}

for (const [f, note] of [
  ["README.md", "For Russian-only projects a much smaller model (`cointegrated/rubert-tiny2`, 312-dim) works if you convert it to ONNX; the model unloads after 5 minutes idle (`MEGAMEMORY_EMBED_IDLE_MS=0` disables that), and `MEGAMEMORY_SEARCH=fts` avoids loading it at all."],
  ["README.ru.md", "Для чисто русских проектов подойдёт значительно меньшая модель (`cointegrated/rubert-tiny2`, 312-мерная) после конвертации в ONNX; модель выгружается после 5 минут простоя (`MEGAMEMORY_EMBED_IDLE_MS=0` отключает выгрузку), а `MEGAMEMORY_SEARCH=fts` не загружает её вовсе."],
] as const) {
  let r = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  if (!r.includes("rubert-tiny2")) {
    const anchor = note.startsWith("For") ? "Requires Node.js >= 18." : "Нужен Node.js >= 18.";
    if (!r.includes(anchor)) { console.error(f + " anchor miss"); process.exit(1); }
    r = r.replace(anchor, anchor + " " + note);
    fs.writeFileSync(f, r);
    console.log(f, "updated");
  }
}
