import type { KnowledgeDB } from "./db.js";

// ---- 2.1.9 F2: опоры-заглушки не принимаются ----
//
// На TwonkyGrabber3 агент закрыл требование опоры узлами вида «File-fact node
// for "…" — created as a provenance support»: у заглушки нет утверждения, она
// не может ни подтвердиться, ни устареть, но в stats, weak_links и отчётах
// выглядит как подтверждение. Один предикат на все потребители: отказ в
// create_concept, тип stub_support в weak_links, quality в provenance_trace,
// строка Stub supports в stats и doctor.

/** Шаблонные саммари: серверный file-fact, упоминание provenance support, «file: …». */
export const STUB_SUMMARY_PATTERN = /file-fact node|provenance support|^file:\s/i;

/** Саммари короче этого — заглушка, если в нём нет глагола-утверждения. */
export const STUB_MAX_UNVERBED_LENGTH = 80;

/** Глагол-утверждение: саммари утверждает что-то о поведении, а не называет файл. */
export const CLAIM_VERB_PATTERN =
  /содержит|хранит|пишет|читает|считает|возвращает|блокирует|требует|кэширует|вызывает|помечает|отдаёт/i;

/**
 * Проверка утверждения применяется только к kinds из decision|feature|pattern
 * (fact в схеме нет) — module это группировка, digest — серверная сводка, у
 * обоих нет собственного утверждения (2.1.9: «чего не делать»).
 */
export const STUB_CHECK_KINDS: ReadonlySet<string> = new Set([
  "decision",
  "feature",
  "pattern",
  "fact",
]);

/** Текст отказа create_concept (F2, дословно из плана). */
export const STUB_REJECTION_MESSAGE =
  "Опора должна быть утверждением о поведении, а не заглушкой.\n" +
  'Файл передавай как evidence: [{ref: "path:строки", why: "что это доказывает"}].\n' +
  "Узел создавай, только если формулируешь мысль, которую нельзя выразить ссылкой.";

/**
 * Заглушка ли это саммари для узла такого kind. Пустой текст — тоже заглушка:
 * утверждением он быть не может ни при каком kind из проверяемых.
 */
export function isStubSummary(
  summary: string | null | undefined,
  kind: string | null | undefined
): boolean {
  if (kind && (kind === "module" || kind === "digest")) return false;
  const text = (summary ?? "").trim();
  if (!text) return true;
  if (STUB_SUMMARY_PATTERN.test(text)) return true;
  return (
    text.length < STUB_MAX_UNVERBED_LENGTH && !CLAIM_VERB_PATTERN.test(text)
  );
}

/**
 * Сколько живых опор (адресатов живых informed_by рёбер) — заглушки. Один
 * запрос, предикат в JS: шаблон и глаголы в SQL не выражаются.
 */
export function countStubSupports(db: KnowledgeDB): number {
  const rows = db.execSqlAll(
    `SELECT nd.id, nd.summary, nd.kind
     FROM edges e JOIN nodes nd ON nd.id = e.to_id
     WHERE e.relation = 'informed_by' AND e.removed_at IS NULL AND nd.removed_at IS NULL
     GROUP BY nd.id, nd.summary, nd.kind`
  ) as Array<{ id: string; summary: string | null; kind: string | null }>;
  return rows.filter((r) => isStubSummary(r.summary, r.kind)).length;
}
