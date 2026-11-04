import { describe, it, expect } from "vitest";
import { buildHelp } from "../help.js";

function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Строка хелпа, описывающая команду (по префиксу до пробелов). */
function commandLine(help: string, command: string): string {
  const lines = plain(help).split("\n").filter((l) => l.trim().startsWith(command + " ") || l.trim() === command);
  expect(lines.length, `command '${command}' not found in help`).toBeGreaterThan(0);
  return lines[0];
}

describe("buildHelp — --db как глобальная опция (2.1.4)", () => {
  const help = plain(buildHelp("2.1.4"));

  it("описывает --db один раз как глобальную опцию без привязки к stats/conflicts/resolve", () => {
    expect(help).toContain("--db");
    expect(help).not.toContain("stats/conflicts/resolve");
    expect(help).toMatch(/--db\s+PATH\s+Path to knowledge\.db/);
    expect(help).toContain("MEGAMEMORY_DB_PATH");
  });

  it("у каждой команды, открывающей базу, указан --db PATH", () => {
    const withDb = ["serve", "stats", "conflicts", "resolve", "repair-ids", "migrate", "reembed", "consolidate", "digest", "export", "doctor", "eval"];
    for (const cmd of withDb) {
      expect(commandLine(help, cmd), `command '${cmd}' must mention --db PATH`).toContain("--db PATH");
    }
  });

  it("команды без базы не упоминают --db", () => {
    for (const cmd of ["install", "merge", "(no"]) {
      expect(commandLine(help, cmd), `command '${cmd}' must not mention --db`).not.toContain("--db");
    }
  });

  it("снапшот текста хелпа", () => {
    expect(plain(buildHelp("2.1.4"))).toMatchSnapshot();
  });
});
