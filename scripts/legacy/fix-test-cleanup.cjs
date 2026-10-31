// One-off: switch test files' afterEach cleanup to the async helper that
// waits for libsql's Windows file-lock release.
const fs = require("fs");

const files = [
  "src/__tests__/conflicts.test.ts",
  "src/__tests__/create-concept.test.ts",
  "src/__tests__/db.test.ts",
  "src/__tests__/get-concept.test.ts",
  "src/__tests__/merge.test.ts",
  "src/__tests__/migration.test.ts",
  "src/__tests__/timeline.test.ts",
];

for (const f of files) {
  let s = fs.readFileSync(f, "utf8");
  const orig = s;

  // afterEach(() => {  →  afterEach(async () => {
  s = s.replace(/afterEach\(\(\) => \{/g, "afterEach(async () => {");

  // db.close(); followed by rmSync line  →  await closeAndCleanup(db, tmpDir);
  s = s.replace(
    /\n\s*db\.close\(\);\n\s*fs\.rmSync\(tmpDir, \{[^}]*\}\);\n/g,
    "\n  await closeAndCleanup(db, tmpDir);\n"
  );

  if (s !== orig && !s.includes("helpers/cleanup.js")) {
    // add import after the last existing import line
    const lines = s.split("\n");
    let lastImport = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^import /.test(lines[i])) lastImport = i;
    }
    lines.splice(
      lastImport + 1,
      0,
      'import { closeAndCleanup } from "./helpers/cleanup.js";'
    );
    s = lines.join("\n");
  }
  if (s !== orig) {
    fs.writeFileSync(f, s, "utf8");
    console.log("updated", f);
  } else {
    console.log("no change", f);
  }
}
