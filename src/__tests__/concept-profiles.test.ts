import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { KnowledgeDB } from "../db.js";
import { getConcept, measureMcpPayload, trimSummary } from "../tools.js";
import { getConceptProfile } from "../concept-profile.js";
import {
  claimDigestOf,
  statusDigestOf,
  edgeDigestOf,
} from "../support-baselines.js";
import {
  artifactsDigestOf,
  activeArtifactRows,
} from "../artifacts.js";
import type { ConceptProfileOutput, NodeWithContext } from "../types.js";
import { cleanupDir } from "./helpers/cleanup.js";

let tmpDir: string;
const openDbs: KnowledgeDB[] = [];

function createTmpDb(name: string): { db: KnowledgeDB; path: string } {
  const dbPath = path.join(tmpDir, name);
  const db = new KnowledgeDB(dbPath);
  openDbs.push(db);
  return { db, path: dbPath };
}

/** Wire-форма, которую реально шлёт MCP-обработчик: pretty-JSON в конверте. */
function wire(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Богатая фикстура: решение с опорами (обычная, refuted, якорь), детьми,
 * рёбрами в обе стороны, trail, slot, просроченным соседом и кириллицей.
 */
function insertFixtureNodes(db: KnowledgeDB): void {
  db.insertNode({
    id: "auth-refresh",
    name: "Auth refresh",
    kind: "decision",
    summary:
      "Тихое обновление токена за 30 секунд до истечения: фоновая проверка в refreshLoop, 401 при /expired ретраит один раз.",
    why: "Долгие джобы падали на 401 при истечении токена — обновление должно быть превентивным.",
    file_refs: ["src/auth/refresh.ts:10-80"],
    created_via: "agent",
  });
  db.insertNode({
    id: "sup-refresh-loop",
    name: "Refresh loop",
    kind: "feature",
    summary:
      "refreshLoop проверяет срок токена каждые 10 секунд и запускает обновление за 30 секунд до истечения.",
    why: "Фон не блокирует запросы.",
    file_refs: ["src/auth/refresh.ts:12-44"],
  });
  db.insertNode({
    id: "sup-cookie-fallback",
    name: "Cookie fallback",
    kind: "pattern",
    summary: "Куки-фолбэк для обновления токена — отклонён на review.",
    epistemic_status: "refuted",
  });
  db.recordStatusHistory(
    "sup-cookie-fallback",
    null,
    "refuted",
    "куки не проходят CSRF-проверку прокси",
    "epistemic_status"
  );
  db.insertNode({
    id: "sup-anchor",
    name: "src/auth/session.ts",
    kind: "feature",
    summary: "src/auth/session.ts:20-60",
    created_via: "file_ref",
  });
  db.insertNode({
    id: "child-a",
    name: "Child A",
    kind: "module",
    summary: "Дочерний модуль A.",
    parent_id: "auth-refresh",
  });
  db.insertNode({
    id: "child-b",
    name: "Child B",
    kind: "pattern",
    summary: "Дочерний модуль B.",
    parent_id: "auth-refresh",
  });
  db.insertNode({ id: "store", name: "Token store", kind: "module", summary: "Хранилище токенов." });
  db.insertNode({ id: "login-flow", name: "Login flow", kind: "feature", summary: "Поток логина." });
  db.insertNode({
    id: "expired-fact",
    name: "Expired fact",
    kind: "journal",
    summary: "Временное утверждение с истёкшим сроком.",
    valid_until: "2020-01-01T00:00:00Z",
  });

  db.insertEdge({
    from_id: "auth-refresh",
    to_id: "sup-refresh-loop",
    relation: "informed_by",
    description: "loop даёт превентивное обновление",
  });
  db.insertEdge({
    from_id: "auth-refresh",
    to_id: "sup-cookie-fallback",
    relation: "informed_by",
    description: "фолбэк отклонён, решение опирается на отклонение",
  });
  db.insertEdge({
    from_id: "auth-refresh",
    to_id: "sup-anchor",
    relation: "informed_by",
    description: "строки 20-60 — сессия и срок",
  });
  db.insertEdge({
    from_id: "auth-refresh",
    to_id: "store",
    relation: "depends_on",
    description: "читает и пишет токен",
  });
  db.insertEdge({
    from_id: "login-flow",
    to_id: "auth-refresh",
    relation: "informed_by",
    description: "логин ставит первый токен",
  });

  db.insertTrail({
    id: "trail-auth",
    name: "auth chain",
    summary: "Как пришли к тихому обновлению.",
    node_ids: ["auth-refresh", "sup-refresh-loop"],
  });
  db.setSlot("auth", "owner", "auth-refresh");
}

interface Fixture {
  db: KnowledgeDB;
  full: NodeWithContext;
}

function loadFixture(name: string): Fixture {
  const { db } = createTmpDb(name);
  insertFixtureNodes(db);
  const full = getConcept(db, { id: "auth-refresh" });
  return { db, full };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "megamemory-concept-profiles-test-"));
});

afterEach(async () => {
  // C1 (план 20+21 v3 §5): все соединения закрываются даже при упавшем тесте.
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      // уже закрыта
    }
  }
  openDbs.length = 0;
  (globalThis as { gc?: () => void }).gc?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await cleanupDir(tmpDir);
});

describe("getConcept: старый контракт (E1)", () => {
  it("одиночный вызов без новых параметров не несёт meta и не меняет набор полей", () => {
    const { db, full } = loadFixture("legacy.db");
    const again = getConcept(db, { id: "auth-refresh" });
    expect(wire(again)).toBe(wire(full));
    expect("meta" in full).toBe(false);
    // Обязательный каркас прежней карточки.
    expect(Object.keys(full).sort()).toEqual(
      [
        "children",
        "created_via",
        "current_digests",
        "due_at",
        "edges",
        "epistemic_status",
        "expired",
        "file_refs",
        "id",
        "informed_by",
        "informed_by_incoming",
        "incoming_edges",
        "kind",
        "name",
        "parent",
        "slots",
        "status",
        "status_scope",
        "support_check",
        "task_state",
        "trails",
        "valid_until",
        "why",
        "summary",
      ].sort()
    );
    db.close();
  });

  it("profile=full совпадает со старым вызовом байт-в-байт", () => {
    const { db, full } = loadFixture("full-profile.db");
    const asProfile = getConceptProfile(db, { id: "auth-refresh", profile: "full" });
    expect(wire(asProfile)).toBe(wire(full));
    db.close();
  });

  it("profile=full с бюджетом не режет карточку, а отказывается при нехватке", () => {
    const { db, full } = loadFixture("full-budget.db");
    const card = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "full",
      max_tokens: 100000,
    });
    expect(wire(card)).toBe(wire(full));
    expect(() =>
      getConceptProfile(db, { id: "auth-refresh", profile: "full", max_tokens: 100 })
    ).toThrow(/max_tokens/);
    db.close();
  });
});

describe("getConcept: профиль orientation (E1)", () => {
  it("несёт идентичность, квалификацию, краткий summary и указатели", () => {
    const { db, full } = loadFixture("orientation-core.db");
    const out = getConceptProfile(db, { id: "auth-refresh", profile: "orientation" }) as ConceptProfileOutput;

    // Ядро квалификации байт-в-байт из полной карточки.
    expect(out.id).toBe(full.id);
    expect(out.name).toBe(full.name);
    expect(out.kind).toBe(full.kind);
    expect(out.status).toBe(full.status);
    expect(out.epistemic_status).toBe(full.epistemic_status);
    expect(out.status_scope).toEqual(full.status_scope);
    expect(out.valid_until).toBe(full.valid_until);
    expect(out.expired).toBe(full.expired);
    expect(out.parent).toEqual(full.parent);
    expect(out.file_refs).toEqual(full.file_refs);
    expect(out.created_via).toBe(full.created_via);
    // Краткий summary — существующее усечение, не новый формат.
    expect(out.summary).toBe(trimSummary(full.summary));
    expect(out.summary.length).toBeLessThanOrEqual(240);
    // Указатели, где брать остальное.
    expect(out.where_next).toContain("evidence");
    expect(out.where_next).toContain("full");
    // meta с оценкой токенов и полными счётчиками.
    expect(out.meta.profile).toBe("orientation");
    // Счётчики совпадают с полной карточкой: edges/incoming_edges — ВСЕ
    // живые рёбра (включая informed_by, как в массивах edges карточки).
    expect(out.meta.counts).toEqual({ children: 2, edges: 4, incoming_edges: 1, informed_by: 3, informed_by_incoming: 1, trails: 1 });
    expect(out.meta.tokens_estimated).toBeGreaterThan(0);
    expect(out.meta.truncated).toBe(false);
    db.close();
  });

  it("раскрытые соседи совпадают с полной карточкой байт-в-байт", () => {
    const { db, full } = loadFixture("orientation-neighbors.db");
    const out = getConceptProfile(db, { id: "auth-refresh", profile: "orientation" }) as ConceptProfileOutput;
    expect(out.children).toEqual(full.children.map(({ summary, ...rest }) => rest));
    expect(out.edges).toEqual(full.edges.map(({ description, ...rest }) => rest));
    expect(out.informed_by).toEqual(full.informed_by!.map(({ rationale, ...rest }) => rest));
    expect(out.informed_by_incoming).toEqual(
      full.informed_by_incoming!.map(({ rationale, ...rest }) => rest)
    );
    expect(out.trails).toEqual(full.trails);
    // Слабая опора видна в карте опор.
    const cookie = out.informed_by!.find((s) => s.to === "sup-cookie-fallback");
    expect(cookie?.weak).toBe(true);
    db.close();
  });

  it("бюджет режет соседей честно: dropped, continuation, токены по wire-форме", () => {
    const { db } = loadFixture("orientation-budget.db");
    // Строим крупную звезду опор, чтобы бюджет и кап реально работали.
    for (let i = 0; i < 40; i++) {
      db.insertNode({ id: `star-${i}`, name: `Star ${i}`, kind: "feature", summary: `Опора ${i} звезды.` });
      db.insertEdge({
        from_id: "auth-refresh",
        to_id: `star-${i}`,
        relation: "informed_by",
        description: `поддерживает вывод ${i}`,
      });
    }
    const out = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "orientation",
      max_neighbors: 5,
      max_tokens: 1300,
    }) as ConceptProfileOutput;

    expect(out.meta.truncated).toBe(true);
    expect(out.meta.counts!.informed_by).toBe(43);
    expect(out.meta.returned!.informed_by).toBeLessThanOrEqual(5);
    expect(out.meta.dropped).toBeDefined();
    expect(out.meta.dropped!.informed_by!).toBeGreaterThan(0);
    expect(out.meta.continuations).toBeDefined();
    expect(out.meta.continuations!.length).toBeGreaterThan(0);
    expect(out.meta.continuations!.some((c) => c.list === "informed_by")).toBe(true);
    // Оценка честная: ровно по фактическому wire-ответу.
    expect(measureMcpPayload(out)).toBe(out.meta.tokens_estimated);
    db.close();
  });

  it("минимум обязательных полей не режется даже крошечным бюджетом; ниже минимума — отказ", () => {
    const { db } = loadFixture("orientation-minimum.db");
    const out = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "orientation",
      max_neighbors: 0,
      max_tokens: 2000,
    }) as ConceptProfileOutput;
    // Ядро живо при полном отсутствии раскрытых соседей.
    expect(out.id).toBe("auth-refresh");
    expect(out.status).toBeDefined();
    expect(out.epistemic_status).toBeDefined();
    expect(out.valid_until).toBeDefined();
    expect(out.expired).toBeDefined();
    expect(out.summary).toBeDefined();
    expect(out.meta.returned).toEqual({ children: 0, edges: 0, incoming_edges: 0, informed_by: 0, informed_by_incoming: 0, trails: 0 });
    expect(() =>
      getConceptProfile(db, { id: "auth-refresh", profile: "orientation", max_tokens: 30 })
    ).toThrow(/max_tokens/);
    db.close();
  });
});

describe("getConcept: профиль evidence (E1)", () => {
  it("несёт полные формулировки, rationale и готовые дайджесты confirm_supports", () => {
    const { db, full } = loadFixture("evidence-core.db");
    const out = getConceptProfile(db, { id: "auth-refresh", profile: "evidence" }) as ConceptProfileOutput;

    // Полная формулировка узла и rationale — не усечённые.
    expect(out.summary).toBe(full.summary);
    expect(out.why).toBe(full.why);
    expect(out.current_digests).toEqual(full.current_digests);
    expect(out.support_check).toEqual(full.support_check);
    expect(out.file_refs).toEqual(full.file_refs);

    const supports = out.supports!;
    expect(supports.map((s) => s.to).sort()).toEqual(
      full.informed_by!.map((s) => s.to).sort()
    );
    for (const s of supports) {
      const row = db.getNode(s.to)!;
      // Полная существенная формулировка опоры — никогда не обрезка.
      expect(s.claim).toBe(row.summary);
      expect(s.claim.length).toBe(row.summary.length);
      // rationale ребра байт-в-байт из полной карточки.
      const edge = full.informed_by!.find((e) => e.to === s.to)!;
      expect(s.rationale).toBe(edge.rationale);
      expect(s.to_name).toBe(edge.to_name);
      // Квалификация опоры едет с ней.
      expect(s.status).toBe(row.status ?? "active");
      expect(s.epistemic_status).toBe(row.epistemic_status ?? null);
      expect(s.valid_until).toBe(row.valid_until ?? null);
      // Версии — те же общие экспорты, что у provenance_trace: клиент не хеширует сам.
      expect(s.digests.claim_digest).toBe(claimDigestOf(row.summary));
      expect(s.digests.status_digest).toBe(statusDigestOf(row.status ?? "active", row.epistemic_status ?? null));
      expect(s.digests.edge_digest).toBe(edgeDigestOf(edge.rationale));
      expect(s.digests.artifacts_digest).toBe(
        artifactsDigestOf(activeArtifactRows(row, db.getNodeArtifacts(s.to)))
      );
      expect(["stub", "claim"]).toContain(s.quality);
    }
    const cookie = supports.find((s) => s.to === "sup-cookie-fallback")!;
    expect(cookie.weak).toBe(true);
    expect(cookie.refuted_reason).toBe("куки не проходят CSRF-проверку прокси");
    db.close();
  });

  it("не помещающиеся доказательства — явная неполнота, а не обрезанные формулировки", () => {
    const { db } = loadFixture("evidence-incomplete.db");
    for (let i = 0; i < 12; i++) {
      db.insertNode({
        id: `ev-${i}`,
        name: `Evidence ${i}`,
        kind: "feature",
        summary: `Существенная формулировка опоры ${i}: параметры, поведение и границы применимости номера ${i} изложены полностью и длинно.`,
      });
      db.insertEdge({
        from_id: "auth-refresh",
        to_id: `ev-${i}`,
        relation: "informed_by",
        description: `рационально связывает вывод с формулировкой ${i}`,
      });
    }
    const out = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      max_neighbors: 3,
      max_tokens: 3000,
    }) as ConceptProfileOutput;

    expect(out.meta.truncated).toBe(true);
    expect(out.supports!.length).toBeLessThanOrEqual(3);
    // Ни одна выданная формулировка не обрезана: сокращённое чтение не выдаётся
    // за достаточное для подтверждения.
    for (const s of out.supports!) {
      expect(s.claim).toBe(db.getNode(s.to)!.summary);
    }
    expect(out.meta.dropped!.informed_by!).toBeGreaterThan(0);
    expect(out.meta.incomplete).toBeDefined();
    const incomplete = out.meta.incomplete!.find((i) => i.section === "informed_by")!;
    expect(incomplete.reason).toBe("budget");
    expect(incomplete.count).toBe(out.meta.dropped!.informed_by);
    expect(incomplete.next_step.length).toBeGreaterThan(0);
    expect(out.meta.continuations!.some((c) => c.list === "informed_by")).toBe(true);
    expect(measureMcpPayload(out)).toBe(out.meta.tokens_estimated);
    db.close();
  });

  it("решение без опор показывает их отсутствие явно, а не молчанием", () => {
    const { db } = loadFixture("evidence-empty.db");
    db.insertNode({
      id: "lonely-decision",
      name: "Lonely decision",
      kind: "decision",
      summary: "Решение, у которого опор нет — и это видно без догадок.",
    });
    const out = getConceptProfile(db, { id: "lonely-decision", profile: "evidence" }) as ConceptProfileOutput;
    expect(out.supports).toEqual([]);
    expect(out.meta.counts!.informed_by).toBe(0);
    expect(out.meta.dropped?.informed_by).toBeUndefined();
    expect(out.current_digests).toBeDefined();
    db.close();
  });

  it("refuted и expired узлы сохраняют квалификацию, причины и срок в обоих профилях", () => {
    const { db } = loadFixture("evidence-qualification.db");
    for (const profile of ["orientation", "evidence"] as const) {
      const refuted = getConceptProfile(db, { id: "sup-cookie-fallback", profile }) as ConceptProfileOutput;
      expect(refuted.epistemic_status).toBe("refuted");
      expect(refuted.refuted_reason).toBe("куки не проходят CSRF-проверку прокси");
      const expired = getConceptProfile(db, { id: "expired-fact", profile }) as ConceptProfileOutput;
      expect(expired.expired).toBe(true);
      expect(expired.valid_until).toBe("2020-01-01T00:00:00Z");
    }
    db.close();
  });

  it("unicode/кириллица едут байт-в-байт между профилем и полной карточкой", () => {
    const { db, full } = loadFixture("evidence-unicode.db");
    const out = getConceptProfile(db, { id: "auth-refresh", profile: "evidence" }) as ConceptProfileOutput;
    expect(wire(out.summary)).toBe(wire(full.summary));
    expect(wire(out.why)).toBe(wire(full.why));
    expect(wire(out.supports!.map((s) => s.claim))).toBe(
      wire(full.informed_by!.map((e) => db.getNode(e.to)!.summary))
    );
    db.close();
  });
});

describe("getConcept: продолжение (E1)", () => {
  it("вторая страница продолжает список без повторов, конфликт при изменении данных", () => {
    const { db } = loadFixture("continuation.db");
    for (let i = 0; i < 10; i++) {
      db.insertNode({ id: `page-${i}`, name: `Page ${i}`, kind: "feature", summary: `Опора страницы ${i}.` });
      db.insertEdge({
        from_id: "auth-refresh",
        to_id: `page-${i}`,
        relation: "informed_by",
        description: `страничная опора ${i}`,
      });
    }
    const page1 = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      max_neighbors: 4,
    }) as ConceptProfileOutput;
    const token = page1.meta.continuations!.find((c) => c.list === "informed_by")!.token;

    const page2 = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      continuation: token,
    }) as ConceptProfileOutput;
    const ids1 = page1.supports!.map((s) => s.to);
    const ids2 = page2.supports!.map((s) => s.to);
    expect(new Set([...ids1, ...ids2]).size).toBe(ids1.length + ids2.length);
    expect(ids2.length).toBeGreaterThan(0);
    expect(page2.meta.continuation_used).toEqual({ list: "informed_by", offset: 4 });
    // Страница 2 несёт тот же обязательный минимум квалификации.
    expect(page2.id).toBe("auth-refresh");
    expect(page2.current_digests).toBeDefined();

    // Изменение формулировки уже выданной опоры -> конфликт версии, не склейка
    // страниц разных состояний.
    db.updateNode("page-0", { summary: "Переписанная формулировка опоры 0." });
    expect(() =>
      getConceptProfile(db, { id: "auth-refresh", profile: "evidence", continuation: token })
    ).toThrow(/version_conflict/);

    // Токен до правки больше не действителен и после добавления новой опоры:
    // состав выборки изменился — конфликт, а не склейка страниц.
    db.insertNode({ id: "page-new", name: "Page new", kind: "feature", summary: "Поздняя опора." });
    db.insertEdge({
      from_id: "auth-refresh",
      to_id: "page-new",
      relation: "informed_by",
      description: "опора, добавленная между страницами",
    });
    expect(() =>
      getConceptProfile(db, { id: "auth-refresh", profile: "evidence", continuation: token })
    ).toThrow(/version_conflict/);
    db.close();
  });

  it("продолжение чужим id и битый токен дают явную ошибку", () => {
    const { db } = loadFixture("continuation-guard.db");
    for (let i = 0; i < 6; i++) {
      db.insertNode({ id: `guard-${i}`, name: `Guard ${i}`, kind: "feature", summary: `Опора ${i}.` });
      db.insertEdge({
        from_id: "auth-refresh",
        to_id: `guard-${i}`,
        relation: "informed_by",
        description: `опора ${i}`,
      });
    }
    const page1 = getConceptProfile(db, {
      id: "auth-refresh",
      profile: "evidence",
      max_neighbors: 2,
    }) as ConceptProfileOutput;
    const token = page1.meta.continuations!.find((c) => c.list === "informed_by")!.token;
    expect(() =>
      getConceptProfile(db, { id: "sup-refresh-loop", profile: "evidence", continuation: token })
    ).toThrow(/не совпадает|mismatch|anchor/i);
    expect(() =>
      getConceptProfile(db, { id: "auth-refresh", profile: "evidence", continuation: "мусор" })
    ).toThrow(/continuation/);
    db.close();
  });
});
