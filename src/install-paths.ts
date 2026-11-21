import os from "os";
import path from "path";

// ---- Единый источник путей инструкций (план 29) ----
//
// install.ts пишет управляемые блоки в файлы правил, instructions.ts читает их
// на каждый ответ MCP. Раньше оба списка путей были рукописными и ничем не
// были связаны: детектор не видел цели zcode и kilo вовсе, а kilo-правила
// распознавал только по legacy-маркеру. Все пути инструкций теперь собираются
// отсюда; новый target install обязан либо добавить сюда функцию, либо явным
// списком исключений объяснить, почему детектор её путь не смотрит
// (гард-тест в instructions.test.ts).
//
// Модуль не импортирует install.ts: тот уже импортирует instructions.ts,
// который импортирует этот модуль, — получился бы цикл.

/**
 * os.homedir() игнорирует $HOME на Windows (читает USERPROFILE), поэтому
 * песочница тестов протекала в реальный профиль — тесты установщика правили
 * настоящий ~/.claude.json и ~/.claude/CLAUDE.md. $HOME учитывается явно:
 * продовые прогоны не затронуты (Git Bash выставляет то же значение),
 * песочницы герметичны. Переехало из install.ts (план 29, дефект 4): детектор
 * раньше читал голый os.homedir() — на Windows тест с подменой $HOME
 * проверял запись и не проверял чтение.
 */
export function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

/** Глобальный каталог конфигурации Kilo (~/.config/kilo). */
export function kiloConfigDir(): string {
  return path.join(homeDir(), ".config", "kilo");
}

/**
 * Каталог конфигурации OpenCode: $OPENCODE_CONFIG_DIR перекрывает пару
 * $XDG_CONFIG_HOME/.config/opencode (как в instructions.ts, так и в
 * install.ts — теперь из одного места).
 */
export function opencodeConfigDir(): string {
  return process.env.OPENCODE_CONFIG_DIR
    ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(homeDir(), ".config"), "opencode");
}

/** Каталог Claude Code (~/.claude). */
export function claudeDir(): string {
  return path.join(homeDir(), ".claude");
}

/** Глобальный каталог ZCode (~/.zcode). */
export function zcodeDir(): string {
  return path.join(homeDir(), ".zcode");
}

/** Проектный AGENTS.md в текущем каталоге — перекрывает глобальные файлы. */
export function projectAgents(): string {
  return path.join(process.cwd(), "AGENTS.md");
}

/** Проектный CLAUDE.md в текущем каталоге. */
export function projectClaude(): string {
  return path.join(process.cwd(), "CLAUDE.md");
}

/** Глобальный AGENTS.md OpenCode (с учётом OPENCODE_CONFIG_DIR). */
export function opencodeAgents(): string {
  return path.join(opencodeConfigDir(), "AGENTS.md");
}

/** Глобальный CLAUDE.md Claude Code. */
export function claudeAgents(): string {
  return path.join(claudeDir(), "CLAUDE.md");
}

/**
 * Активный каталог профиля Codex: непустая (после trim) $CODEX_HOME, иначе
 * ~/.codex. Значение используется как есть — пути с пробелами и кириллицей
 * допустимы (B-10, аудит 2026-11-12). Единственный источник резолва: и
 * install (config.toml + AGENTS.md цели codex), и скан инструкций обязаны
 * видеть один и тот же активный профиль.
 */
export function codexHome(): string {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.trim() !== ""
    ? process.env.CODEX_HOME
    : path.join(homeDir(), ".codex");
}

/**
 * AGENTS.md активного профиля Codex — путь записи цели codex (install) и
 * первый кандидат скана. До плана 30 детектор читал только codexAgents():
 * при непустой $CODEX_HOME установка писала блок в активный профиль, а
 * instructions_version оставался null навсегда — instructions_stale не
 * поднимался и после npm update агент молча работал по старому блоку.
 */
export function codexAgentsTarget(): string {
  return path.join(codexHome(), "AGENTS.md");
}

/**
 * Дефолтный ~/.codex/AGENTS.md, без $CODEX_HOME. Цель codex сюда НЕ пишет
 * (путь записи — codexAgentsTarget()); в скане это fallback после активного
 * профиля: у части пользователей блок остался в ~/.codex от установки до
 * появления переменной, и без него они получали бы null при живом блоке.
 * Путь kilo --global (prepareAgentsConvention в install.ts) продолжает
 * писать именно сюда — поведение записи kilo не менялось (план 30).
 */
export function codexAgents(): string {
  return path.join(homeDir(), ".codex", "AGENTS.md");
}

/**
 * Кандидаты скана Codex в порядке приоритета: активный
 * $CODEX_HOME/AGENTS.md при заданной переменной, затем ~/.codex/AGENTS.md.
 * Когда переменная пуста или не задана, пути совпадают — дедуп оставляет
 * один; перекрёстный дедуп с остальными целями остаётся в
 * instructionsCandidates (по realpath).
 */
export function codexAgentsCandidates(): string[] {
  const active = codexAgentsTarget();
  const fallback = codexAgents();
  return active === fallback ? [fallback] : [active, fallback];
}

/**
 * AGENTS.md с указателем на скилл, который пишет цель kilo: глобально —
 * ~/.config/kilo/AGENTS.md, в проекте — тот же проектный AGENTS.md.
 */
export function kiloAgents(global: boolean): string {
  return global ? path.join(kiloConfigDir(), "AGENTS.md") : projectAgents();
}

/**
 * Файл правил цели zcode: глобально — ~/.zcode/AGENTS.md, в проекте —
 * тот же проектный AGENTS.md.
 */
export function zcodeAgents(global: boolean): string {
  return global ? path.join(zcodeDir(), "AGENTS.md") : projectAgents();
}

/**
 * Канонический ~/.agents/AGENTS.md из `install --link`: симлинк на файл
 * правил цели kilo (global — ~/.config/kilo/AGENTS.md, проект — ./AGENTS.md).
 * Сканируется как самостоятельный кандидат: ссылка может указывать и на
 * чужой файл; дедуп по realpath (instructionsCandidates) убирает двойное
 * чтение, когда цель совпадает.
 */
export function agentsCanonical(global: boolean): string {
  return path.join(global ? homeDir() : process.cwd(), ".agents", "AGENTS.md");
}

/**
 * Файл правил цели kilo: глобальный ~/.config/kilo/rules/megamemory.md
 * (новый JSONC-конфиг в домашнем каталоге) либо проектные
 * .kilo/rules/megamemory.md (новый формат) / .kilocode/rules/megamemory.md
 * (legacy). Legacy-глобального пути не существует — глобальный флаг
 * игнорирует format.
 */
export function kiloRules(global: boolean, format: "jsonc" | "legacy"): string {
  if (global) return path.join(kiloConfigDir(), "rules", "megamemory.md");
  return path.join(process.cwd(), format === "jsonc" ? ".kilo" : ".kilocode", "rules", "megamemory.md");
}
