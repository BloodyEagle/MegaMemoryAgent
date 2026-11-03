import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  extractInstructionsVersion,
  instructionsStamp,
  instructionsStatus,
} from "../instructions.js";

const SERVER_VERSION = "2.0.0-fork.1";

function tmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-instructions-"));
  const file = path.join(dir, "AGENTS.md");
  fs.writeFileSync(file, content);
  return file;
}

describe("instructionsStatus (plan 3 step 7.3)", () => {
  it("reports stale when the stamp carries an older version (7.4.3)", () => {
    const file = tmpFile(`${instructionsStamp("1.9.0-fork.1")}\n## Project Knowledge Graph\n`);

    expect(instructionsStatus(SERVER_VERSION, [file])).toEqual({
      instructions_stale: true,
      instructions_version: "1.9.0-fork.1",
      server_version: SERVER_VERSION,
    });
  });

  it("reports fresh when the stamp matches the server version (7.4.4)", () => {
    const file = tmpFile(`${instructionsStamp(SERVER_VERSION)}\n## Project Knowledge Graph\n`);

    expect(instructionsStatus(SERVER_VERSION, [file])).toEqual({
      instructions_stale: false,
      instructions_version: SERVER_VERSION,
      server_version: SERVER_VERSION,
    });
  });

  it("reports false + null when there is no instructions file (7.4.5)", () => {
    const missing = path.join(os.tmpdir(), "mm-instructions-absent", "AGENTS.md");

    expect(instructionsStatus(SERVER_VERSION, [missing])).toEqual({
      instructions_stale: false,
      instructions_version: null,
      server_version: SERVER_VERSION,
    });
  });

  it("skips files without megamemory stamps instead of misfiring on them", () => {
    const own = tmpFile("# My agents file\n\nUser rules only, no megamemory here.\n");
    const installed = tmpFile(`${instructionsStamp(SERVER_VERSION)}\n## Project Knowledge Graph\n`);

    expect(instructionsStatus(SERVER_VERSION, [own, installed]).instructions_stale).toBe(false);
  });

  it("treats a legacy v2-managed block without a version stamp as stale", () => {
    const file = tmpFile(
      "<!-- megamemory-snippet:v2 -->\n## Project Knowledge Graph\n\nold workflow\n<!-- /megamemory-snippet -->\n"
    );

    expect(instructionsStatus(SERVER_VERSION, [file])).toEqual({
      instructions_stale: true,
      instructions_version: null,
      server_version: SERVER_VERSION,
    });
  });

  it("returns the same three fields on every call — the shape understand and list_roots share (7.4.6)", () => {
    const file = tmpFile(`${instructionsStamp("0.9.0")}\n`);

    const first = instructionsStatus(SERVER_VERSION, [file]);
    const second = instructionsStatus(SERVER_VERSION, [file]);

    expect(Object.keys(first).sort()).toEqual([
      "instructions_stale",
      "instructions_version",
      "server_version",
    ]);
    expect(first).toEqual(second);
  });
});

describe("instructionsStamp / extractInstructionsVersion", () => {
  it("round-trips the package version through the stamp", () => {
    const stamp = instructionsStamp("2.0.0-fork.1");
    expect(stamp).toBe("<!-- megamemory:instructions v2.0.0-fork.1 -->");
    expect(extractInstructionsVersion(`intro\n${stamp}\nmore`)).toBe("2.0.0-fork.1");
  });

  it("returns null for content without a stamp", () => {
    expect(extractInstructionsVersion("# My agents file\n")).toBeNull();
    expect(extractInstructionsVersion("<!-- megamemory-snippet:v2 -->\n")).toBeNull();
  });
});
