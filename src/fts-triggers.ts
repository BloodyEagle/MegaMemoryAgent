import type { KnowledgeDB } from "./db.js";

export function ftsTriggerDefinitions(trigram = false): Record<string, string> {
  const table = trigram ? "nodes_fts_tri" : "nodes_fts";
  const prefix = trigram ? "nodes_tri" : "nodes";
  return {
    [`${prefix}_ai`]: `CREATE TRIGGER ${prefix}_ai AFTER INSERT ON nodes BEGIN INSERT INTO ${table}(rowid,name,summary,why) VALUES(new.rowid,new.name,new.summary,new.why); END`,
    [`${prefix}_ad`]: `CREATE TRIGGER ${prefix}_ad AFTER DELETE ON nodes BEGIN INSERT INTO ${table}(${table},rowid,name,summary,why) VALUES('delete',old.rowid,old.name,old.summary,old.why); END`,
    [`${prefix}_au`]: `CREATE TRIGGER ${prefix}_au AFTER UPDATE ON nodes BEGIN INSERT INTO ${table}(${table},rowid,name,summary,why) VALUES('delete',old.rowid,old.name,old.summary,old.why); INSERT INTO ${table}(rowid,name,summary,why) VALUES(new.rowid,new.name,new.summary,new.why); END`,
  };
}

const normalized = (sql: string) => sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, "").replace(/;$/, "").toLowerCase();

export function readFtsTriggerHealth(db: KnowledgeDB, trigram = false): { healthy: boolean; missing: string[]; wrong: string[] } {
  const missing: string[] = [], wrong: string[] = [];
  for (const [name, expected] of Object.entries(ftsTriggerDefinitions(trigram))) {
    const row = db.execSqlFirst("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?", name) as { sql: string } | undefined;
    if (!row) missing.push(name);
    else if (normalized(row.sql) !== normalized(expected)) wrong.push(name);
  }
  return { healthy: missing.length === 0 && wrong.length === 0, missing, wrong };
}

export function ensureFtsTriggerSet(db: KnowledgeDB, trigram = false): boolean {
  const health = readFtsTriggerHealth(db, trigram);
  if (health.healthy) return false;
  const definitions = ftsTriggerDefinitions(trigram);
  for (const name of health.wrong) db.execSql(`DROP TRIGGER "${name}"`);
  for (const name of [...health.missing, ...health.wrong]) db.execSql(definitions[name]);
  return true;
}
