/**
 * MEGAMEMORY_TOOLS: фильтр поверхности инструментов (план 26 §1, 2.11.0).
 *
 * Все 26 инструментов регистрируются безусловно, и их описания висят в
 * контексте каждой сессии; агент на меню из 26 узких инструментов
 * промахивается. Переменная сужает поверхность ДО регистрации — состав
 * `tools/list` честно отражает фильтр, динамической регистрации нет.
 *
 * Значения:
 *  - не задано или `all` — все 26 (текущее поведение, дефолт не меняется);
 *  - `core` — 8 инструментов цикла «прочитал → записал → связал →
 *    подтвердил → проверил»;
 *  - список через запятую — ровно перечисленные имена.
 *
 * Неизвестное имя в списке — предупреждение в stderr и пропуск, а не падение.
 * Установщик поведение новых установок не меняет: env в MCP-запись не пишется
 * (решение владельца, план 26 §1).
 */

/** Все имена инструментов в порядке регистрации в src/index.ts. */
export const TOOL_NAMES = [
  "understand",
  "get_concept",
  "create_concept",
  "update_concept",
  "link",
  "remove_concept",
  "list_roots",
  "list_conflicts",
  "resolve_conflict",
  "provenance_trace",
  "provenance_audit",
  "confirm_supports",
  "provenance_history",
  "check_artifacts",
  "check_freshness",
  "trail_save",
  "trail_get",
  "trail_refresh",
  "trail_extend",
  "slot_set",
  "slot_get",
  "slot_release",
  "slot_list",
  "task_add",
  "task_done",
  "board",
] as const;

/** Цикл «прочитал → записал → связал → подтвердил → проверил». */
export const CORE_TOOL_NAMES = [
  "understand",
  "get_concept",
  "create_concept",
  "update_concept",
  "link",
  "confirm_supports",
  "check_freshness",
  "provenance_trace",
] as const;

const ALL = new Set<string>(TOOL_NAMES);
const CORE = new Set<string>(CORE_TOOL_NAMES);

export interface ToolSurface {
  mode: "all" | "core" | "list";
  enabled: Set<string>;
}

/**
 * Разобрать значение `MEGAMEMORY_TOOLS`. Пустое/незаданное значение и `all`
 * дают полную поверхность; `core` — ядро из восьми; остальное — список через
 * запятую. Неизвестные имена предупреждают в stderr и пропускаются.
 */
export function parseToolSurface(env: string | undefined): ToolSurface {
  const value = env?.trim();
  if (!value || value === "all") return { mode: "all", enabled: new Set(ALL) };
  if (value === "core") return { mode: "core", enabled: new Set(CORE) };
  const enabled = new Set<string>();
  for (const raw of value.split(",")) {
    const name = raw.trim();
    if (!name) continue;
    if (!ALL.has(name)) {
      console.error(
        `megamemory: MEGAMEMORY_TOOLS: неизвестное имя "${name}" — пропущено (см. TOOL_NAMES в src/tool-surface.ts).`
      );
      continue;
    }
    enabled.add(name);
  }
  return { mode: "list", enabled };
}
