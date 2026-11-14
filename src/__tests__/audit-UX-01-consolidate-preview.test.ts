import { describe, expect, it } from "vitest";
import { auditDom, graphNode, type AuditDomReply, type AuditDomRequest } from "./helpers/audit-dom.js";

const OLDER = "older-node";
const NEWER = "newer-node";
const LONG_TAIL = "ХВОСТ-ПОЛНОГО-ТЕКСТА";

/** План последствий (planConsolidation) с настраиваемыми полями. */
function planFixture(
  survivor: string,
  other: string,
  overrides: Partial<ReturnType<typeof planBase> & { rejection?: string }> = {}
) {
  return { ...planBase(survivor, other), ...overrides };
}

function planBase(survivor: string, other: string) {
  // B-02 (аудит 2026-11-12): preview отвечает планом ВМЕСТЕ с карточками
  // участников (cards.survivor/other, null — узла нет). Содержимое карточек
  // совпадает с прежними отдельными ответами /api/node/:id.
  const member = (id: string) => cardFixture(id, id === NEWER ? { status: "deprecated", file_refs: ["src/b.ts"] } : {});
  return {
    survivor,
    other,
    base: {
      digest: "b".repeat(64),
      survivor_updated_at: "2026-11-07 10:00:00",
      other_updated_at: "2026-11-07 10:00:00",
    },
    cards: { survivor: member(survivor), other: member(other) },
    summaryCombines: true,
    finalSummary: "объединённое описание",
    whySource: "survivor" as const,
    finalWhy: "kept why",
    fileRefs: ["src/a.ts"],
    refsAdded: ["src/b.ts"],
    edgesToMove: [{ from_id: survivor, to_id: "peer", relation: "connects_to", description: "edge" }],
    edgesDropped: 1,
    children: [{ id: "kid", name: "kid" }],
    slots: [{ project: "proj", role: "handoff" }],
    trailMembers: 2,
    artifacts: 1,
    baselines: 3,
    taskCarries: true,
    taskState: "open",
    dueAt: "2030-01-01",
    statusDiverges: true,
    confirmationsAffected: true,
  };
}

const previewUrl = (survivor: string, other: string) =>
  `/api/consolidate/preview?survivor=${encodeURIComponent(survivor)}&other=${encodeURIComponent(other)}`;

/** Полная карточка: различия между нодами видны, длинный текст не обрезан. */
function cardFixture(id: string, overrides: Record<string, unknown> = {}) {
  const longSummary = `${"Очень длинное описание. ".repeat(80)}${LONG_TAIL}`;
  return graphNode(id, {
    summary: id === OLDER ? longSummary : "Короткое второе описание",
    ...overrides,
  }) as unknown as Record<string, unknown>;
}

/** Роутер ответов с мутируемым состоянием (после merge граф без дубля). */
function makeReplies(options: {
  planOverride?: Partial<ReturnType<typeof planBase>>;
  cardBStatus?: number;
  postReply?: AuditDomReply;
} = {}) {
  const state = {
    merged: false,
    // B-02: недоступный узел в bundle — null-слот карточки (бывший 404
    // отдельного /api/node/:id).
    cardBStatus: options.cardBStatus ?? 200,
    postCount: 0,
  };
  const previewBody = (survivor: string, other: string) => {
    const plan = planFixture(survivor, other, options.planOverride);
    if (state.cardBStatus !== 200) return { ...plan, cards: { ...plan.cards, other: null } };
    return plan;
  };
  const reply = ({ url, method }: AuditDomRequest): AuditDomReply | undefined => {
    if (url === "/api/consolidate" && method === "GET") {
      return {
        body: {
          candidates: [{ a: OLDER, b: NEWER, older: OLDER, similarity: 0.92 }],
        },
      };
    }
    if (url === "/api/consolidate" && method === "POST") {
      state.postCount++;
      if (options.postReply) return options.postReply;
      state.merged = true;
      return { body: { ok: true, survivor: OLDER, removed: NEWER } };
    }
    if (url === previewUrl(OLDER, NEWER)) {
      return { body: previewBody(OLDER, NEWER) };
    }
    if (url === previewUrl(NEWER, OLDER)) {
      return { body: previewBody(NEWER, OLDER) };
    }
    if (url === `/api/node/${encodeURIComponent(OLDER)}`) {
      return { body: cardFixture(OLDER) };
    }
    if (url === `/api/node/${encodeURIComponent(NEWER)}`) {
      if (state.cardBStatus !== 200) return { body: { error: "Concept not found" }, status: state.cardBStatus };
      return { body: cardFixture(NEWER, { status: "deprecated", file_refs: ["src/b.ts"] }) };
    }
    if (url === "/api/graph") {
      return {
        body: {
          nodes: state.merged ? [cardFixture(OLDER)] : [cardFixture(OLDER), cardFixture(NEWER)],
          edges: [],
        },
      };
    }
    return undefined;
  };
  return { reply, state };
}

async function openPreview(ui: Awaited<ReturnType<typeof auditDom>>) {
  ui.dispatch(ui.element("#consolidate-btn"), "click");
  await ui.settle();
  const compare = ui.element("#stats").querySelectorAll("button")
    .find((button) => button.getAttribute("data-action") === "consolidate-compare");
  expect(compare).toBeDefined();
  ui.dispatch(compare!, "click");
  await ui.settle();
  return ui.element("#consolidate-preview");
}

function chooseSurvivor(panel: ReturnType<Awaited<ReturnType<typeof auditDom>>["element"]>, side: string) {
  const choice = panel.querySelectorAll("button")
    .find((button) => button.getAttribute("data-action") === "consolidate-survivor"
      && button.getAttribute("data-side") === side);
  expect(choice, `survivor choice ${side}`).toBeDefined();
  return choice!;
}

describe("UX-01 — сравнение двух нод перед Consolidate", () => {
  it("compare открывает обе реальные карточки; до финального подтверждения в сети только GET", async () => {
    const { reply, state } = makeReplies();
    const ui = await auditDom({ reply });
    try {
      const panel = await openPreview(ui);
      const text = panel.textContent;
      // Обе карточки с их данными, различия видны, длинный summary читается
      // полностью — хвост длинного текста присутствует.
      expect(text).toContain(OLDER);
      expect(text).toContain(NEWER);
      expect(text).toContain("deprecated");
      expect(text).toContain(LONG_TAIL);
      expect(text).toContain("src/b.ts");
      expect(panel.querySelectorAll("audit-marker")).toHaveLength(0);
      expect(ui.errors).toEqual([]);
      expect(state.postCount).toBe(0);
      expect(ui.requests.filter((request) => request.method === "POST")).toHaveLength(0);
      // Смена survivor — тоже чтение, не мутация.
      ui.dispatch(chooseSurvivor(panel, "A"), "click");
      await ui.settle();
      ui.dispatch(chooseSurvivor(ui.element("#consolidate-preview"), "B"), "click");
      await ui.settle();
      expect(ui.requests.some((request) => request.url === previewUrl(NEWER, OLDER))).toBe(true);
      expect(ui.requests.filter((request) => request.method === "POST")).toHaveLength(0);
      expect(state.postCount).toBe(0);
    } finally { ui.close(); }
  });

  it.each([
    ["cancel in confirm", "confirm"],
    ["close button", "close"],
    ["Escape", "escape"],
  ])("%s отправляет ноль POST и не меняет граф", async (_label, way) => {
    const { reply, state } = makeReplies();
    const ui = await auditDom({ reply });
    try {
      const before = ui.graphState();
      const panel = await openPreview(ui);
      ui.dispatch(chooseSurvivor(panel, "A"), "click");
      await ui.settle();
      if (way === "escape") {
        ui.dispatch(ui.element("body"), "keydown", { key: "Escape" });
        await ui.settle();
      } else {
        const merge = ui.element("#consolidate-preview").querySelectorAll("button")
          .find((button) => button.getAttribute("data-action") === "consolidate-merge");
        expect(merge!.hasAttribute("disabled")).toBe(false);
        ui.dispatch(merge!, "click");
        await ui.settle();
        const action = way === "confirm" ? "consolidate-cancel-confirm" : "consolidate-close";
        const button = ui.element("#consolidate-preview").querySelectorAll("button")
          .find((button) => button.getAttribute("data-action") === action);
        expect(button).toBeDefined();
        ui.dispatch(button!, "click");
        await ui.settle();
      }
      // Панель закрыта, POST не было, граф/запросы не тронуты.
      expect(ui.requests.filter((request) => request.method === "POST")).toHaveLength(0);
      expect(state.postCount).toBe(0);
      expect(documentContains(ui, "consolidate-preview")).toBe(false);
      const after = ui.graphState();
      expect(after.nodes.map((node) => node.id).sort()).toEqual(before.nodes.map((node) => node.id).sort());
      expect(after.edges).toEqual(before.edges);
      expect(ui.alerts).toEqual([]);
    } finally { ui.close(); }
  });

  it("merge остаётся disabled, пока карточки bundle не загружены; недоступная карточка даёт retry без POST", async () => {
    const { reply, state } = makeReplies({ cardBStatus: 404 });
    const ui = await auditDom({ reply });
    try {
      const panel = await openPreview(ui);
      expect(panel.textContent).toContain("card failed");
      // merge disabled при неполных данных.
      const merge = panel.querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-merge");
      expect(merge!.hasAttribute("disabled")).toBe(true);
      // retry перечитывает bundle (GET), ошибки POST нет.
      const previewGets = () => ui.requests.filter((request) => request.url.startsWith("/api/consolidate/preview")).length;
      const before = previewGets();
      const retry = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-retry");
      expect(retry).toBeDefined();
      ui.dispatch(retry!, "click");
      await ui.settle();
      expect(previewGets()).toBeGreaterThan(before);
      expect(ui.element("#consolidate-preview").textContent).toContain("card failed");
      expect(state.postCount).toBe(0);
      // Данные починились — retry доводит панель до готовности.
      state.cardBStatus = 200;
      const retry2 = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-retry");
      ui.dispatch(retry2!, "click");
      await ui.settle();
      const panel2 = ui.element("#consolidate-preview");
      const merge2 = panel2.querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-merge");
      // Без выбора survivor merge всё ещё disabled (нет скрытого автовыбора).
      expect(merge2!.hasAttribute("disabled")).toBe(true);
      ui.dispatch(chooseSurvivor(panel2, "A"), "click");
      await ui.settle();
      const merge3 = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-merge");
      expect(merge3!.hasAttribute("disabled")).toBe(false);
      expect(state.postCount).toBe(0);
    } finally { ui.close(); }
  });

  it("double-click финального подтверждения отправляет POST один раз", async () => {
    const { reply, state } = makeReplies();
    const ui = await auditDom({ reply });
    try {
      const panel = await openPreview(ui);
      ui.dispatch(chooseSurvivor(panel, "A"), "click");
      await ui.settle();
      const merge = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-merge");
      ui.dispatch(merge!, "click");
      await ui.settle();
      const confirm = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-confirm");
      expect(confirm).toBeDefined();
      ui.dispatch(confirm!, "click");
      ui.dispatch(confirm!, "click");
      await ui.settle();
      expect(state.postCount).toBe(1);
      const body = JSON.parse(ui.requests.find((request) => request.method === "POST")!.body!);
      expect(body).toMatchObject({ survivor: OLDER, other: NEWER });
      expect(body.base.digest).toEqual(expect.any(String));
    } finally { ui.close(); }
  });

  it("409 version_conflict: ноль записей, bundle перечитан, подтверждение запрошено заново", async () => {
    const { reply, state } = makeReplies({
      postReply: { body: { error: "version_conflict", detail: "the merge inputs changed" }, status: 409 },
    });
    const ui = await auditDom({ reply });
    try {
      const panel = await openPreview(ui);
      ui.dispatch(chooseSurvivor(panel, "A"), "click");
      await ui.settle();
      const bundleReadsBefore = ui.requests.filter((request) => request.url.startsWith("/api/consolidate/preview")).length;
      const merge = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-merge");
      ui.dispatch(merge!, "click");
      await ui.settle();
      const confirm = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-confirm");
      ui.dispatch(confirm!, "click");
      await ui.settle();
      expect(state.postCount).toBe(1);
      // Перечитывание: новый GET bundle (план+карточки) после отказа.
      const bundleReadsAfter = ui.requests.filter((request) => request.url.startsWith("/api/consolidate/preview")).length;
      expect(bundleReadsAfter).toBeGreaterThan(bundleReadsBefore);
      // Подтверждение сброшено: заново просят merge → confirm, сам merge не выполнен.
      expect(ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-confirm")).toBeUndefined();
      expect(ui.element("#consolidate-preview").textContent).toContain("confirm again");
      const merge2 = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-merge");
      expect(merge2!.hasAttribute("disabled")).toBe(false);
      expect(state.merged).toBe(false);
      expect(ui.location.reloads).toBe(0);
    } finally { ui.close(); }
  });

  it("SSE-изменение ноды пары и reconnect помечают preview устаревшим; merge сам не выполняется", async () => {
    const { reply, state } = makeReplies();
    const ui = await auditDom({ reply });
    try {
      const panel = await openPreview(ui);
      ui.dispatch(chooseSurvivor(panel, "A"), "click");
      await ui.settle();
      ui.sse({ type: "node_updated", data: { id: NEWER, name: "changed elsewhere" } });
      await ui.settle();
      expect(ui.element("#consolidate-preview").textContent).toContain("preview stale");
      const merge = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-merge");
      expect(merge!.hasAttribute("disabled")).toBe(true);
      expect(state.postCount).toBe(0);
      // Reconnect тоже помечает устаревшим: onerror + onopen без событий.
      ui.sse({ type: "stats", data: {} }, true);
      await ui.settle();
      expect(ui.element("#consolidate-preview").textContent).toContain("preview stale");
      expect(state.postCount).toBe(0);
      expect(ui.requests.filter((request) => request.method === "POST")).toHaveLength(0);
    } finally { ui.close(); }
  });

  it("self-pair: серверный отказ в preview блокирует merge", async () => {
    const { reply } = makeReplies();
    const ui = await auditDom({
      reply: ({ url }) => {
        if (url === previewUrl(OLDER, OLDER)) {
          return { body: planFixture(OLDER, OLDER, { rejection: `Cannot consolidate "${OLDER}" into itself — survivor and duplicate must be distinct live nodes.` }) };
        }
        if (url === `/api/node/${encodeURIComponent(OLDER)}`) return { body: cardFixture(OLDER) };
        return undefined;
      },
    });
    try {
      await ui.invoke("openConsolidatePreview", OLDER, OLDER, { older: OLDER, similarity: 1 });
      const panel = ui.element("#consolidate-preview");
      ui.dispatch(chooseSurvivor(panel, "A"), "click");
      await ui.settle();
      expect(panel.textContent).toContain("merge is rejected");
      expect(panel.textContent).toContain("into itself");
      const merge = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-merge");
      expect(merge!.hasAttribute("disabled")).toBe(true);
      expect(ui.requests.filter((request) => request.method === "POST")).toHaveLength(0);
    } finally { ui.close(); }
  });

  it("после успеха показан настоящий survivor, граф перечитан без поглощённой ноды, кандидаты обновлены", async () => {
    const { reply, state } = makeReplies();
    const ui = await auditDom({ reply });
    try {
      const panel = await openPreview(ui);
      ui.dispatch(chooseSurvivor(panel, "A"), "click");
      await ui.settle();
      const merge = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-merge");
      ui.dispatch(merge!, "click");
      await ui.settle();
      const confirm = ui.element("#consolidate-preview").querySelectorAll("button")
        .find((button) => button.getAttribute("data-action") === "consolidate-confirm");
      ui.dispatch(confirm!, "click");
      await ui.settle();
      const text = ui.element("#consolidate-preview").textContent;
      expect(text).toContain("merged");
      expect(text).toContain(OLDER);
      expect(text).toContain('origin "unknown"');
      // Граф перечитан: поглощённая нода исчезла.
      const graphIds = ui.graphState().nodes.map((node) => node.id).sort();
      expect(graphIds).toContain(OLDER);
      expect(graphIds).not.toContain(NEWER);
      // Кандидаты перечитаны после POST (обновление списка).
      const postIndex = ui.requests.findIndex((request) => request.method === "POST");
      const candidatesAfter = ui.requests
        .filter((request, index) => request.url === "/api/consolidate"
          && request.method === "GET" && index > postIndex);
      expect(candidatesAfter.length).toBeGreaterThan(0);
      expect(state.postCount).toBe(1);
      expect(ui.location.reloads).toBe(0);
    } finally { ui.close(); }
  });
});

function documentContains(ui: Awaited<ReturnType<typeof auditDom>>, selector: string): boolean {
  return ui.requests ? Boolean(query(ui, selector)) : false;
}

// querySelector по документу harness: element бросает, если элемента нет.
function query(ui: Awaited<ReturnType<typeof auditDom>>, selector: string) {
  try {
    return ui.element(selector);
  } catch {
    return null;
  }
}
