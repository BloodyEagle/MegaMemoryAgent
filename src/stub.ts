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
 *
 * 2.1.10 F1: проверка применяется только к узлам, созданным агентом
 * (created_via = 'agent', значение по умолчанию — вызов на этапе создания
 * узла, когда строки ещё нет). Якоря (created_via = 'file_ref') не считаются
 * заглушками никогда — их шаблонное саммари так задумано; прочие происхождения
 * (import/auto/null) заглушками не называются: неизвестное происхождение не
 * имеет права изобличать узел.
 */
export function isStubSummary(
  summary: string | null | undefined,
  kind: string | null | undefined,
  createdVia: string | null | undefined = "agent"
): boolean {
  if (createdVia !== "agent") return false;
  if (kind && (kind === "module" || kind === "digest")) return false;
  const text = (summary ?? "").trim();
  if (!text) return true;
  if (STUB_SUMMARY_PATTERN.test(text)) return true;
  return (
    text.length < STUB_MAX_UNVERBED_LENGTH && !CLAIM_VERB_PATTERN.test(text)
  );
}

/**
 * 2.1.10 F1: одноразовый критерий миграции v12 — выглядит ли старая строка
 * как якорь `evidence: [{ref}]`. Три признака сразу: шаблонное саммари
 * file-fact, file_refs[0] совпадает с именем, имя выглядит как путь.
 * Всё остальное — ручной узел.
 *
 * 2.1.11 F1: требование «:строка» снято — ссылка на файл целиком
 * (`plans/report.md`) тоже законная опора, старый бэкфилл помечал её
 * `agent` и считал заглушкой. Признак пути: в имени есть разделитель
 * каталогов — обычная фраза на `/` или `\` не похожа, — и нет пробелов
 * по краям. Ложные опознания почти исключены: нужны и шаблонное саммари,
 * и совпадение имени с первым file_ref одновременно.
 */
export const FILE_REF_NAME_SHAPE = /[\\/]/;

export function looksLikeFilePath(name: string): boolean {
  return name.trim() === name && FILE_REF_NAME_SHAPE.test(name);
}

export function looksLikeFileRefAnchor(
  summary: string | null | undefined,
  name: string,
  fileRefs: string[] | null | undefined
): boolean {
  if (!summary || !STUB_SUMMARY_PATTERN.test(summary)) return false;
  if (!fileRefs || fileRefs.length === 0 || fileRefs[0] !== name) return false;
  return looksLikeFilePath(name);
}

export interface SupportQualityBreakdown {
  total: number;
  anchors: number;
  claims: number;
  stubs: number;
}

/**
 * 2.1.10 F1: разбивка живых опор (адресатов живых informed_by рёбер) по
 * происхождению: якоря (file_ref), утверждения (всё остальное) и — внутри
 * ручных — заглушки. Один запрос, предикат в JS: шаблон и глаголы в SQL не
 * выражаются.
 */
export function supportQualityBreakdown(db: KnowledgeDB): SupportQualityBreakdown {
  const rows = db.execSqlAll(
    `SELECT nd.id, nd.summary, nd.kind, nd.created_via
     FROM edges e JOIN nodes nd ON nd.id = e.to_id
     WHERE e.relation = 'informed_by' AND e.removed_at IS NULL AND nd.removed_at IS NULL
     GROUP BY nd.id, nd.summary, nd.kind, nd.created_via`
  ) as Array<{
    id: string;
    summary: string | null;
    kind: string | null;
    created_via: string | null;
  }>;
  const out: SupportQualityBreakdown = { total: rows.length, anchors: 0, claims: 0, stubs: 0 };
  for (const r of rows) {
    if (r.created_via === "file_ref") out.anchors++;
    else out.claims++;
    if (isStubSummary(r.summary, r.kind, r.created_via)) out.stubs++;
  }
  return out;
}

/** Сколько живых опор — заглушки (только ручные, created_via = 'agent'). */
export function countStubSupports(db: KnowledgeDB): number {
  return supportQualityBreakdown(db).stubs;
}
