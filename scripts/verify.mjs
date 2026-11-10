import fs from "node:fs";
import path from "node:path";
import { ROOT, runBounded, isolatedEnvironment, temporaryDirectory, cleanup, offlineImports, reportFailure } from "./verify-utils.mjs";

export function assertDevRuntime() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  // Vite (the Vitest toolchain) requires a newer engine than the product CLI.
  if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 24)) {
    throw new Error(`DEV_NODE_UNSUPPORTED ${process.version}; Vitest needs Node 20.19+, 22.12+, or 24+. The product runtime minimum stays 20.9 (engines).`);
  }
}

export async function verifyTypes(tests = false) {
  const profile = temporaryDirectory("typecheck");
  try {
    await runBounded(process.execPath, [path.join(ROOT, "node_modules/typescript/bin/tsc"), "--project", path.join(ROOT, tests ? "tsconfig.tests.json" : "tsconfig.json"), "--noEmit", "--pretty", "false"], {
      env: isolatedEnvironment(profile), label: tests ? "typecheck-tests" : "typecheck",
    });
  } finally { await cleanup(profile); }
}

export async function verifyTests(args) {
  assertDevRuntime();
  const profile = temporaryDirectory("tests");
  let failure;
  try {
    const env = isolatedEnvironment(profile);
    await runBounded(process.execPath, [...offlineImports(), path.join(ROOT, "node_modules/vitest/vitest.mjs"), "run", ...args], { env, label: "test" });
  } catch (error) { failure = error; }
  finally {
    // Always run the post-process fixture guard, including failures/timeouts.
    try { await runBounded(process.execPath, [path.join(ROOT, "scripts/check-fixtures.mjs")], { env: isolatedEnvironment(profile), label: "posttest" }); }
    catch (error) { if (failure) console.error(failure.message); failure = error; }
    try { await cleanup(profile); } catch (error) { if (failure) console.error(failure.message); failure = error; }
  }
  if (failure) throw failure;
}

export function verifyMetadata(tag) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const filename of ["README.md", "README.ru.md"]) {
    const match = fs.readFileSync(path.join(ROOT, filename), "utf8").match(/version-([0-9]+\.[0-9]+\.[0-9]+(?:--fork\.[0-9]+)?)/);
    if (!match || match[1].replace("--", "-") !== manifest.version) throw new Error(`VERSION_BADGE_MISMATCH ${filename}`);
  }
  if (tag !== undefined && tag.replace(/^v/, "") !== manifest.version) throw new Error(`RELEASE_VERSION_MISMATCH ${tag} != ${manifest.version}`);
  console.log(`metadata: pass (${manifest.version})`);
}

try {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "typecheck" || mode === "typecheck-tests") {
    if (args.length) throw new Error("Typecheck does not accept extra arguments.");
    await verifyTypes(mode === "typecheck-tests");
  } else if (mode === "test") await verifyTests(args);
  else if (mode === "metadata" && args.length <= 1) verifyMetadata(args[0]);
  else throw new Error("Usage: node scripts/verify.mjs typecheck|typecheck-tests|test [Vitest arguments]|metadata [release tag]");
} catch (error) { reportFailure(error); }
