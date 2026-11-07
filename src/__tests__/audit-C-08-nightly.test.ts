import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { AuditHarnessError } from "./helpers/audit.js";

function nightlySteps() {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/nightly.yml", import.meta.url), "utf8");
  // The agreed seam is the checked-in pipeline contract, not a nightly run.
  // Read step blocks (including named and multiline run steps), not comments
  // mentioning build/test. No YAML or package-manager dependency is installed.
  const full = workflow.match(/^  full:\s*\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/m)?.[1];
  if (!full) throw new AuditHarnessError("Expected the nightly full job to be present");
  return full.split(/^      - /m).slice(1).map((block) => {
    const run = block.match(/^(?:\s*)run:\s*(.*)$/m)?.[1];
    if (!run) return { block, command: "" };
    const command = /^[|>][-+]?\s*$/.test(run)
      ? block.split(/\r?\n/).filter((line) => /^          \S/.test(line)).map((line) => line.trim()).join("\n")
      : run.replace(/\s+#.*$/, "").trim();
    return { block, command };
  });
}

const invokesTest = /\bnpm\s+(?:run\s+)?test\b|\bvitest\s+run\b/;
const invokesBuild = /\bnpm\s+run\s+build\b/;

describe("C-08 nightly prepares dist before dist-dependent integrations", () => {
  it("performs a required build before the first test command on a clean checkout", () => {
    const steps = nightlySteps();
    const testAt = steps.findIndex(({ command }) => invokesTest.test(command));
    if (testAt < 0) throw new AuditHarnessError("No nightly test invocation was recognized");
    const manifest = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    const explicitBuild = steps.slice(0, testAt).some(({ block, command }) =>
      invokesBuild.test(command) && !/continue-on-error:\s*true/.test(block),
    );
    const command = steps[testAt].command;
    const buildInTestStep = invokesBuild.test(command)
      && command.search(invokesBuild) < command.search(invokesTest)
      && command.includes("&&");
    const pretestBuild = invokesBuild.test(manifest.scripts.pretest ?? "");

    expect(explicitBuild || buildInTestStep || pretestBuild,
      "C-08: clean checkout has no dist; build must precede npm test (prepublishOnly is not pretest)",
    ).toBe(true);
  });

  it("installs declared dependencies before running the nightly tests", () => {
    const steps = nightlySteps();
    const installAt = steps.findIndex(({ command }) => /^npm ci(?:\s|$)/.test(command));
    const testAt = steps.findIndex(({ command }) => invokesTest.test(command));

    expect(installAt).toBeGreaterThanOrEqual(0);
    expect(testAt).toBeGreaterThan(installAt);
  });

  it("includes integrations in the default suite and exposes the compiled CLI", () => {
    const config = fs.readFileSync(new URL("../../vitest.config.ts", import.meta.url), "utf8");
    const manifest = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      bin: { megamemory: string }; scripts: { test: string };
    };

    // Package/config metadata is the contract: moving the server launcher to
    // a shared HTTP helper must not change this test's outcome.
    expect(config).toContain('include: ["tests/integration/**/*.test.ts"]');
    expect(manifest.scripts.test).toMatch(/\bvitest\s+run\b/);
    expect(manifest.bin.megamemory).toBe("dist/index.js");
  });
});
