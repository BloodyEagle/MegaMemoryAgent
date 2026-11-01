// F10: never claim an unknown embedding model (final, clean).
const fs = require("fs");
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const write = (f, s) => { fs.writeFileSync(f, s.replace(/\r\n/g, "\n")); console.log("patched", f); };

// ---- migrate-schema.ts ----
let ms = read("src/migrate-schema.ts");
if (!ms.includes('setMetaValue("embed_model", "unknown")')) {
  const old = `export function ensureEmbedMeta(
  db: KnowledgeDB,
  report: MigrationReport
): void {
  const model = db.getMetaValue("embed_model");
  if (model === undefined) {
    db.setMetaValue("embed_model", CURRENT_EMBED_MODEL);
    report.applied.push(\`set meta.embed_model=\${CURRENT_EMBED_MODEL}\`);
    return;
  }
  if (model !== CURRENT_EMBED_MODEL) {
    report.warnings.push(
      \`embedding model changed: \${model} -> \${CURRENT_EMBED_MODEL}; run 'megamemory reembed'\`
    );
    report.reembedNeeded = true;
  }
}`;
  const neu = `export function ensureEmbedMeta(
  db: KnowledgeDB,
  report: MigrationReport
): void {
  const model = db.getMetaValue("embed_model");
  const withVectors = (
    db.execSqlFirst(
      "SELECT count(*) AS n FROM nodes WHERE embedding IS NOT NULL"
    ) as { n: number }
  ).n;

  if (model === undefined) {
    if (withVectors > 0) {
      // F10: vectors exist, but their model is unknown (an upstream database).
      // Claiming the current model would silently mix vector spaces: both
      // MiniLM and e5-small are 384-dim, so nothing would crash — the ranking
      // would just be quietly wrong. Stamp "unknown" instead; reembed nulls
      // the old vectors and re-stamps the real model.
      db.setMetaValue("embed_model", "unknown");
      report.warnings.push(
        \`\${withVectors} node(s) carry embeddings of an unknown model; \` +
          \`vector search is disabled until 'megamemory reembed'\`
      );
      report.reembedNeeded = true;
      return;
    }
    db.setMetaValue("embed_model", CURRENT_EMBED_MODEL);
    report.applied.push(\`set meta.embed_model=\${CURRENT_EMBED_MODEL}\`);
    return;
  }
  if (model !== CURRENT_EMBED_MODEL) {
    report.warnings.push(
      \`embedding model changed: \${model} -> \${CURRENT_EMBED_MODEL}; run 'megamemory reembed'\`
    );
    report.reembedNeeded = true;
  }
}`;
  if (!ms.includes(old)) { console.error("ensureEmbedMeta miss"); process.exit(1); }
  ms = ms.replace(old, neu);
}
if (!ms.includes("vectors of unknown model")) {
  const dryOld = `  if (!opts.apply) {
    // Dry-run: nothing written. Surface what apply WOULD do.
    report.warnings.push(\`dry run: \${repairPlan.entries.length} id(s) would be renamed\`);
    report.reembedNeeded = db.getMetaValue("embed_model") !== undefined &&
      db.getMetaValue("embed_model") !== CURRENT_EMBED_MODEL;
    return report;
  }`;
  const dryNew = `  if (!opts.apply) {
    // Dry-run: nothing written. Surface what apply WOULD do.
    report.warnings.push(\`dry run: \${repairPlan.entries.length} id(s) would be renamed\`);
    const stamped = db.getMetaValue("embed_model");
    const unknownVectors =
      stamped === undefined
        ? (db.execSqlFirst(
            "SELECT count(*) AS n FROM nodes WHERE embedding IS NOT NULL"
          ) as { n: number }).n
        : 0;
    report.reembedNeeded =
      (stamped !== undefined && stamped !== CURRENT_EMBED_MODEL) ||
      unknownVectors > 0;
    if (unknownVectors > 0) {
      report.warnings.push(
        \`reembed required: \${unknownVectors} vectors of unknown model\`
      );
    }
    return report;
  }`;
  if (!ms.includes(dryOld)) { console.error("dry-run miss"); process.exit(1); }
  ms = ms.replace(dryOld, dryNew);
}
write("src/migrate-schema.ts", ms);

// ---- doctor.ts: unknown model = problem (exit 1) ----
let doc = read("src/doctor.ts");
if (!doc.includes("model unknown")) {
  const old = `  add(
    "embedding model",
    model === MODEL_NAME,
    model
      ? model === MODEL_NAME
        ? \`\${model} (dim=\${dim ?? "?"}, vector search on)\`
        : \`\${model} != current \${MODEL_NAME} — vector search off, run 'megamemory reembed'\`
      : "not recorded — run 'megamemory migrate --apply'"
  );`;
  const neu = `  // F10: unknown-model vectors are a problem, not a note — exit 1 makes CI
  // and the acceptance flow catch a mixed vector space before it is served.
  const vectors = healthReport(db).vectors;
  add(
    "embedding model",
    model === MODEL_NAME,
    model === "unknown"
      ? \`model unknown · vectors \${vectors.have}/\${vectors.total} · run 'megamemory reembed'\`
      : model
        ? model === MODEL_NAME
          ? \`\${model} (dim=\${dim ?? "?"}, vector search on)\`
          : \`\${model} != current \${MODEL_NAME} — vector search off, run 'megamemory reembed'\`
        : "not recorded — run 'megamemory migrate --apply'"
  );`;
  if (!doc.includes(old)) { console.error("doctor check miss"); process.exit(1); }
  doc = doc.replace(old, neu);
  write("src/doctor.ts", doc);
}

console.log("F10 done");
