import fs from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { AuditHarnessError } from "./helpers/audit.js";

// Already present in package-lock via the production dependency tree.
// Metadata only: do not npm ci, install, or launch another Node runtime.
const semver = createRequire(import.meta.url)("semver") as {
  minVersion(range: string): { version: string } | null;
  satisfies(version: string, range: string): boolean;
};

type Manifest = { engines: { node: string }; dependencies: Record<string, string> };
type LockedPackage = {
  version?: string;
  dev?: boolean;
  optional?: boolean;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
};

function metadata() {
  const manifest = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as Manifest;
  const lock = JSON.parse(fs.readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8")) as { packages: Record<string, LockedPackage> };
  return { manifest, lock };
}

function incompatibleRequiredPackages(packages: Record<string, LockedPackage>, runtime: string) {
  // Optional platform packages and dev-toolchain engines are separate from
  // the production minimum promised by the installed package.
  return Object.entries(packages)
    .filter(([name, pkg]) => name !== "" && !pkg.dev && !pkg.optional && pkg.engines?.node)
    .filter(([, pkg]) => !semver.satisfies(runtime, pkg.engines!.node!))
    .map(([name, pkg]) => `${name}@${pkg.version}: requires ${pkg.engines!.node}`)
    .sort();
}

describe("C-07 published Node minimum matches locked production dependencies", () => {
  it("supports every required production engine at the advertised minimum", () => {
    const { manifest, lock } = metadata();
    const minimum = semver.minVersion(manifest.engines.node);
    if (!minimum) throw new AuditHarnessError("package.json must declare a valid Node semver range");

    const incompatible = incompatibleRequiredPackages(lock.packages, minimum.version);

    expect(incompatible, `C-07: Node ${minimum.version} is advertised but rejected by production dependencies`).toEqual([]);
  });

  it("accepts Node 22, the current nightly runtime, for production dependencies", () => {
    const { manifest, lock } = metadata();

    expect(semver.satisfies("22.0.0", manifest.engines.node)).toBe(true);
    expect(incompatibleRequiredPackages(lock.packages, "22.0.0")).toEqual([]);
  });

  it("keeps the root lockfile engines and runtime dependencies aligned with the manifest", () => {
    const { manifest, lock } = metadata();

    expect(lock.packages[""]?.engines).toEqual(manifest.engines);
    expect(lock.packages[""]?.dependencies).toEqual(manifest.dependencies);
  });
});
