import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---- 2.1.9 F1: d3 ships with the package ----
//
// serve renders {{D3_SRC}} into the page; before 2.1.9 it pointed at
// /vendor/d3.min.js while the tarball carried no web/vendor/ at all — every
// install got a 404 and a blank page. The vendor file now lives in the
// package; the CDN below is only a fallback for deployments that copied
// dist/ without web/. MEGAMEMORY_D3_URL wins over both (offline setups with
// a self-hosted mirror).

/** Path of the vendored file, relative to the package root. */
export const D3_VENDOR_RELPATH = "web/vendor/d3.min.js";

/** URL the template gets when the local file is in place. */
export const D3_LOCAL_SRC = "/vendor/d3.min.js";

/** Fallback when the local file is missing — never a silent 404. */
export const D3_CDN_URL = "https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js";

/** Printed at serve start (and by doctor) when the vendor file is missing. */
export const D3_CDN_FALLBACK_NOTE =
  "d3: локальный файл не найден, используется CDN";

export type D3Source = "local" | "cdn" | "env";

function resolveWebDir(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  // From dist/d3-asset.js → ../web/vendor
  return path.resolve(thisDir, "..", "web");
}

/** Absolute path where the vendored d3 is expected (exists or not). */
export function d3VendorFile(): string {
  return path.join(resolveWebDir(), "vendor", "d3.min.js");
}

/** Which of the three sources serves the page right now. */
export function d3Source(): D3Source {
  const env = process.env.MEGAMEMORY_D3_URL?.trim();
  if (env) return "env";
  return fs.existsSync(d3VendorFile()) ? "local" : "cdn";
}

/** Injected exists-check so tests can simulate a missing vendor file. */
type ExistsFn = (p: string) => boolean;

/**
 * The {{D3_SRC}} value plus where it came from. The note is non-null only
 * for the CDN fallback — the one case that must never pass silently.
 */
export function resolveD3Src(
  existsFn: ExistsFn = fs.existsSync
): { src: string; source: D3Source; note: string | null } {
  const env = process.env.MEGAMEMORY_D3_URL?.trim();
  if (env) return { src: env, source: "env", note: null };
  if (existsFn(d3VendorFile())) {
    return { src: D3_LOCAL_SRC, source: "local", note: null };
  }
  return { src: D3_CDN_URL, source: "cdn", note: D3_CDN_FALLBACK_NOTE };
}
