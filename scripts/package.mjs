import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { reportFailure } from "./verify-utils.mjs";
import { packAndVerify } from "./package-flow.mjs";

try {
  // npm pack --json exact capture + composition validation + installed-layout
  // smoke with redirected local dependencies. No node_modules link or junction
  // is created; no packages are installed; dist is packed as-is, so the
  // authorized build must run before the final verification.
  const destination = path.resolve(process.argv[2] ?? "");
  if (!destination) throw new Error("Usage: node scripts/package.mjs [staging-directory]");
  const result = await packAndVerify(destination);
  console.log(JSON.stringify(result));
} catch (error) {
  reportFailure(error);
}
