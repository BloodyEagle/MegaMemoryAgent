import { pluralRu } from "./next-hints.js";
import type { NextHints } from "./types.js";

// ---- План 13 §2.2: режим brief в understand ----
//
// До 8 строк текста плюс блок next, БЕЗ карточек: для клиентов, которые
// проглатывают JSON-стены. compact остаётся режимом по умолчанию; brief —
// для агентов, а не для людей. Здесь только рендер текста брифа: сборка
// узлов, бюджет и wire-мера — в understand (tools.ts), контракт действия —
// buildNextHints (next-hints.ts, группа A, используется как есть).
//
// Форма текста (строго ≤ 8 строк, без markdown-стен):
//   1. сколько чего нашлось по видам (решения, факты, модули...);
//   2–4. ключевые узлы — имя + главный file_ref (до трёх, ранговый порядок);
//   5. «не читай X целиком — покрыто» из next.skip;
//   6. следующий шаг из next.followups (инструмент + узел);
//   7. строка next.record.

/**
 * Текст пустого ответа (план 13 §2.2): «по запросу ничего не нашлось»;
 * next при этом несёт пустые списки и форму записи.
 */
export const BRIEF_EMPTY_TEXT = "По запросу ничего не нашлось.";

/** Узел, лёгший в основу брифа: имя, вид и file_refs (главный — первый). */
export interface BriefNodeInfo {
  name: string;
  kind: string;
  fileRefs: string[];
}

/** Имя узла в строке брифа не длиннее этого. */
const NAME_MAX = 80;
/** Пояснение follow-up в строке брифа не длиннее этого. */
const WHY_MAX = 120;
/** Потолок одной строки брифа: восемь коротких строк не взрывают бюджет. */
const LINE_MAX = 240;
/** Узлов в тексте («Ключевое» + «Также»): 1 + 3 + 1 + 1 + 1 = 7 ≤ 8 строк. */
const KEY_NODES_LIMIT = 3;
/** Файлов в строке «Не читай …»: перечисляются первые два, дальше «и ещё N». */
const SKIP_LIST_LIMIT = 2;

/** Русские названия видов узлов по числу: pluralRu(3, "решение", "решения", "решений"). */
const KIND_RU: Record<string, [string, string, string]> = {
  decision: ["решение", "решения", "решений"],
  fact: ["факт", "факта", "фактов"],
  feature: ["фича", "фичи", "фич"],
  module: ["модуль", "модуля", "модулей"],
  pattern: ["паттерн", "паттерна", "паттернов"],
  config: ["конфиг", "конфига", "конфигов"],
  component: ["компонент", "компонента", "компонентов"],
  digest: ["дайджест", "дайджеста", "дайджестов"],
};

/** В одну строку: любой перенос внутри входных данных сломал бы «≤ 8 строк». */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Обрезка одной строки по границе слова с многоточием (алгоритм trimSummary). */
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let cut = maxChars - 1;
  // Не резать внутри суррогатной пары.
  const low = text.charCodeAt(cut);
  if (low >= 0xdc00 && low <= 0xdfff) cut -= 1;
  const space = text.lastIndexOf(" ", cut);
  if (space > maxChars / 2) cut = space;
  return text.slice(0, cut).trimEnd() + "…";
}

/** Узел follow-up из его готовых аргументов (node_ids | id | node_id). */
function nodeOfArgs(args: Record<string, unknown>): string {
  const v = args.node_ids ?? args.id ?? args.node_id;
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "?";
}

/**
 * Отрендерить текст брифа из узлов-основы и блока next. Текст строится ИЗ
 * next (skip/followups/record), поэтому после бюджетной порезки next текст
 * и блок не расходятся: обе части рендерятся из одного и того же объекта.
 */
export function renderBrief(nodes: BriefNodeInfo[], next: NextHints): string {
  if (nodes.length === 0) return BRIEF_EMPTY_TEXT;

  const lines: string[] = [];

  // (1) Сколько чего нашлось по видам: сначала самые многочисленные.
  const byKind = new Map<string, number>();
  for (const n of nodes) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
  const counts = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([kind, count]) => {
      const forms = KIND_RU[kind] ?? ([kind, kind, kind] as [string, string, string]);
      return `${count} ${pluralRu(count, forms[0], forms[1], forms[2])}`;
    });
  lines.push(clip(`Найдено: ${counts.join(", ")}.`, LINE_MAX));

  // (2) Ключевые узлы: имя + главный file_ref, до трёх в ранговом порядке.
  for (let i = 0; i < Math.min(nodes.length, KEY_NODES_LIMIT); i++) {
    const role = i === 0 ? "Ключевое" : "Также";
    const ref = nodes[i].fileRefs.length > 0 ? oneLine(nodes[i].fileRefs[0]) : "";
    const name = clip(oneLine(nodes[i].name), NAME_MAX);
    lines.push(clip(ref ? `${role}: ${name} (${ref}).` : `${role}: ${name}.`, LINE_MAX));
  }

  // (3) «Не читай X целиком — покрыто» — из next.skip.
  if (next.skip.length > 0) {
    const listed = next.skip.slice(0, SKIP_LIST_LIMIT).map((s) => oneLine(s.ref));
    const more = next.skip.length - listed.length;
    const tail = more > 0 ? ` и ещё ${more}` : "";
    lines.push(clip(`Не читай ${listed.join(", ")}${tail} целиком — покрыто.`, LINE_MAX));
  }

  // (4) Следующий шаг — первый follow-up: инструмент + узел (+ почему).
  const followup = next.followups[0];
  if (followup) {
    const why = followup.why ? ` (${clip(oneLine(followup.why), WHY_MAX)})` : "";
    lines.push(
      clip(`Дальше: ${followup.tool} для узла ${nodeOfArgs(followup.args)}${why}.`, LINE_MAX)
    );
  }

  // (5) Строка next.record — форма записи по итогам задачи.
  lines.push(clip(oneLine(next.record), LINE_MAX));

  return lines.join("\n");
}
