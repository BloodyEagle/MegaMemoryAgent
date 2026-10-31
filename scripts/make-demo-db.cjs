// Acceptance fixture (plan 3.3): 12 nodes — ru/en/zh/emoji, one superseded,
// one digest, one duplicate pair. Usage: node scripts/make-demo-db.cjs <out.db>
const fs = require("fs");
const path = require("path");

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/make-demo-db.cjs <out.db>");
  process.exit(1);
}
fs.rmSync(out, { force: true });
fs.rmSync(out + "-wal", { force: true });
fs.rmSync(out + "-shm", { force: true });

const { KnowledgeDB } = require(path.join(__dirname, "..", "dist", "db.js"));
const { ensureSchema } = require(path.join(__dirname, "..", "dist", "migrate-schema.js"));

const db = new KnowledgeDB(out);
ensureSchema(db);

db.insertNode({ id: "книга", name: "Книга", kind: "module", summary: "заметки о книгах и рецептах" });
db.insertNode({ id: "книга/поиск", name: "Поиск", kind: "feature", summary: "полнотекстовый поиск по книге", parent_id: "книга" });
db.insertNode({ id: "book", name: "Book Reader", kind: "component", summary: "epub reader component" });
db.insertNode({ id: "模块", name: "模块设计", kind: "module", summary: "支付模块的总体设计" });
db.insertNode({ id: "模块/支付", name: "支付网关", kind: "feature", summary: "处理支付请求", parent_id: "模块" });
db.insertNode({ id: "node-rocket", name: "🚀 rocket", kind: "pattern", summary: "rocket emoji node for search" });
db.insertNode({ id: "cafe", name: "café", kind: "config", summary: "diacritics slug check" });

// superseded decision replaced by a newer one
db.insertNode({ id: "auth-v1", name: "Auth Decision", kind: "decision", summary: "use session cookies" });
db.setNodeStatus("auth-v1", "superseded", new Date().toISOString());
db.insertNode({ id: "auth-v2", name: "Auth Decision v2", kind: "decision", summary: "use jwt tokens" });
db.insertEdge({ from_id: "auth-v2", to_id: "auth-v1", relation: "supersedes" });

// duplicate pair (consolidate candidate)
db.insertNode({ id: "dup-a", name: "Payment Module", kind: "module", summary: "processes payments" });
db.insertNode({ id: "dup-b", name: "Payment Module Copy", kind: "module", summary: "processes payments (copy)" });

// digest over 5 children of "книга"
for (let i = 1; i <= 5; i++) {
  db.insertNode({ id: `книга/глава-${i}`, name: `Глава ${i}`, kind: "feature", summary: `содержимое главы ${i}`, parent_id: "книга" });
}
const digestId = "книга/digest";
db.insertNode({
  id: digestId,
  name: "Книга — digest",
  kind: "digest",
  summary: "7 concepts: Поиск — полнотекстовый поиск по книге; Глава 1 — содержимое главы 1; …",
  parent_id: "книга",
});

const count = db.getAllNodesRaw().length;
db.close();
console.log(`demo fixture written: ${out} (${count} nodes)`);
