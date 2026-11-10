import { register } from "node:module";
import path from "node:path";

// No node_modules link in either the checkout or the extracted package.
// Bare ESM imports of the extracted package resolve from the existing local
// node_modules; relative imports and #subpath imports stay inside the package.
// ESM import conditions are preserved because resolution starts at the anchor
// package.json instead of rewriting specifiers.
if (!process.env.MEGAMEMORY_PACKAGE_ROOT || !process.env.MEGAMEMORY_LOCAL_DEPS) {
  throw new Error("PACKAGE_LOADER_PATHS_REQUIRED: set MEGAMEMORY_PACKAGE_ROOT and MEGAMEMORY_LOCAL_DEPS");
}
register(new URL("./package-loader.mjs", import.meta.url), { parentURL: import.meta.url });
