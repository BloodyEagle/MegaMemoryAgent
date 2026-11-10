import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { ROOT, runBounded, isolatedEnvironment, temporaryDirectory, cleanup, offlineImports, reportFailure } from "./verify-utils.mjs";

// Mirrors the composition contract of the historical publish workflow.
const REQUIRED = [
  "package/dist/index.js",
  "package/web/index.html",
  "package/web/vendor/d3.min.js",
  "package/plugin/megamemory.ts",
  "package/commands",
  "package/docs",
  "package/fixtures/eval.jsonl",
  "package/fixtures/demo.db",
  "package/README.md",
  "package/README.ru.md",
  "package/LICENSE",
  "package/package.json",
];
const FORBIDDEN = ["package/src", "package/tests", "package/plans"];

function npmCliPath() {
  const directory = path.dirname(process.execPath);
  const candidates = [
    path.join(directory, "node_modules/npm/bin/npm-cli.js"),
    path.join(directory, "..", "lib/node_modules/npm/bin/npm-cli.js"),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return path.resolve(candidate);
  throw new Error("NPM_CLI_NOT_FOUND: no npm-cli.js next to the running Node runtime");
}

function systemTar() {
  if (process.platform === "win32") {
    const tar = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(tar)) return tar;
  }
  return "tar";
}

export async function packTarball(destination) {
  fs.mkdirSync(destination, { recursive: true });
  const { stdout } = await runBounded(process.execPath, [npmCliPath(), "pack", "--json", "--ignore-scripts", "--pack-destination", destination], { label: "npm-pack", capture: true });
  // Exact capture: the filename comes from npm's JSON output, never from ls/head.
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error(`PACK_JSON_CAPTURE_FAILED: no JSON array in npm pack output (${logHint()})`);
  const [entry] = JSON.parse(stdout.slice(start, end + 1));
  if (!entry?.filename) throw new Error("PACK_JSON_INCOMPLETE: npm pack output has no filename");
  const tarball = path.join(destination, entry.filename);
  const result = {
    filename: entry.filename,
    name: entry.name,
    version: entry.version,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex"),
    size: fs.statSync(tarball).size,
    packed_files: Array.isArray(entry.files) ? entry.files.length : null,
  };
  fs.writeFileSync(path.join(destination, "pack-result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  return { tarball, ...result };
}

function logHint() {
  return process.env.MEGAMEMORY_VERIFY_LOG_DIR ? `see ${process.env.MEGAMEMORY_VERIFY_LOG_DIR}` : "see the run log";
}

export function validateComposition(entries) {
  const problems = [];
  for (const entry of entries) {
    if (!entry.startsWith("package/") || entry.split("/").includes("..") || entry.includes("\\")) problems.push(`unsafe entry: ${entry}`);
  }
  for (const required of REQUIRED) {
    const prefix = required.endsWith("/") ? required : `${required}/`;
    if (!entries.some((entry) => entry === required || entry.startsWith(prefix))) problems.push(`missing: ${required}`);
  }
  for (const forbidden of FORBIDDEN) {
    if (entries.some((entry) => entry === forbidden || entry.startsWith(`${forbidden}/`))) problems.push(`forbidden present: ${forbidden}`);
  }
  return problems;
}

async function listTarball(tarball) {
  const { stdout } = await runBounded(systemTar(), ["-tzf", tarball], { label: "tar-list", capture: true });
  return stdout.split(/\r?\n/).filter(Boolean);
}

async function extractTarball(tarball, destination) {
  await runBounded(systemTar(), ["-xzf", tarball, "-C", destination], { label: "tar-extract" });
}

function verifyManifestEquality(extracted) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const packed = JSON.parse(fs.readFileSync(path.join(extracted, "package", "package.json"), "utf8"));
  if (packed.name !== manifest.name || packed.version !== manifest.version) {
    throw new Error(`PACKAGED_MANIFEST_MISMATCH: ${packed.name}@${packed.version} != ${manifest.name}@${manifest.version}`);
  }
  return `${packed.name}@${packed.version}`;
}

// Installed-layout smoke without installing: bare imports of the extracted
// package resolve into the existing project node_modules through the loader
// redirect. Honest limitation: this is not an npm-install dependency check.
async function smokeInstalledLayout(extracted) {
  const packageRoot = path.join(extracted, "package");
  const profile = temporaryDirectory("package-smoke");
  try {
    const env = isolatedEnvironment(profile);
    env.MEGAMEMORY_PACKAGE_ROOT = packageRoot;
    env.MEGAMEMORY_LOCAL_DEPS = ROOT;
    const entry = path.join(packageRoot, "dist", "index.js");
    const imports = ["--import", pathToFileURL(path.join(ROOT, "scripts", "package-deps.mjs")).href, ...offlineImports()];
    await runBounded(process.execPath, [...imports, entry, "--version"], { env, label: "package-smoke-version" });
    await runBounded(process.execPath, [...imports, entry, "--help"], { env, label: "package-smoke-help" });
    const database = path.join(profile, "demo-copy.db");
    fs.copyFileSync(path.join(packageRoot, "fixtures", "demo.db"), database);
    await runBounded(process.execPath, [...imports, entry, "stats", "--db", database], { env, label: "package-smoke-stats" });
  } finally {
    await cleanup(profile);
  }
}

export async function packAndVerify(destination) {
  const packed = await packTarball(destination);
  const entries = await listTarball(packed.tarball);
  const problems = validateComposition(entries);
  if (problems.length > 0) throw new Error(`COMPOSITION_FAILED (${problems.length}):\n${problems.join("\n")}`);
  const extracted = temporaryDirectory("package-extract");
  try {
    await extractTarball(packed.tarball, extracted);
    const identity = verifyManifestEquality(extracted);
    await smokeInstalledLayout(extracted);
    return { package: "pass", identity, entries: entries.length, smoke: "version+help+stats(fts, loopback-only)", install: "none: local dependency redirect, no node_modules link", ...packed, tarball: packed.tarball };
  } finally {
    await cleanup(extracted);
  }
}

export { reportFailure };
