/**
 * 2.1.13 F2: единый разбор файловых ссылок — один контракт для
 * check_artifacts и bench. Раньше их было два: bench резал «:строки»
 * (splitRefSuffix), check_artifacts отдавал файловой системе сырую строку,
 * и ссылка вида src/db.ts:605-643 навсегда оставалась missing.
 *
 * Контракт:
 *  - git-схемы распознаются ДО файловой нормализации и не режутся;
 *  - у файловой ссылки отрезается только распознанный КОНЕЧНЫЙ локатор;
 *  - Windows не ломается: буква диска (C:\…), UNC (\\srv\share), двоеточия
 *    и # внутри имени остаются на месте;
 *  - локатор ограничивает область ЦИТИРОВАНИЯ, но не область хеша —
 *    хешируется файл целиком (см. README).
 */

/** <rev>:<path> — git blob; a Windows drive path (C:\…) never matches:
 * the prefix before ':' must be HEAD or 6..40 hex chars. */
const GIT_REF_RE = /^(HEAD|[0-9a-fA-F]{6,40}):(.+)$/;

/** git:tag:<name> / git:commit:<sha> / git:branch:<name>.
 * Имя проверяется на безопасность аргумента git (ref не через shell): без
 * пробелов и управляющих символов, без "..", не начинается с "-" или ".". */
const GIT_SCHEME_RE = /^git:(tag|commit|branch):([^\s~^:?*\[\\]+)$/;

/** Полный sha или сокращение от 7 символов (git ambiguity threshold). */
const GIT_SHA_RE = /^[0-9a-fA-F]{7,40}$/;

export type ArtifactKind = "file" | "git_blob" | "git_ref";

export interface ClassifiedRef {
  kind: ArtifactKind;
  /** For git_blob: the part before ':' ("HEAD", a sha…). */
  rev?: string;
  /** For git_ref: tag | commit | branch. */
  scheme?: "tag" | "commit" | "branch";
  /** For git_ref: имя тега, sha или ветки. */
  name?: string;
}

export function classifyRef(ref: string): ClassifiedRef {
  const g = ref.match(GIT_SCHEME_RE);
  if (g) {
    const name = g[2];
    // Имя не может начинаться с "-", "." — иначе git съест его как флаг.
    if (name.startsWith("-") || name.startsWith(".") || name.includes("..")) {
      return { kind: "file" };
    }
    if (g[1] === "commit" && !GIT_SHA_RE.test(name)) return { kind: "file" };
    return { kind: "git_ref", scheme: g[1] as "tag" | "commit" | "branch", name };
  }
  const m = ref.match(GIT_REF_RE);
  if (m) return { kind: "git_blob", rev: m[1] };
  return { kind: "file" };
}

/** Хвост-локатор «:12» / «:12-30»: только цифры и один дефис. */
const LINE_RANGE_RE = /^\d+(?:-\d+)?$/;
/** Хвост-локатор «#L12» / «#L12-L30» (GitHub-стиль). */
const L_LOCATOR_RE = /^L(\d+)(?:-L(\d+))?$/;

/**
 * Отрезать конечный файловый локатор. Сначала «:N(-M)» (последнее двоеточие),
 * затем «#L12(-L30)» (последняя решётка). Индексы 0/1 не режутся: «C:\…» —
 * буква диска, «#L12» целиком — имя файла, а не ссылка с локатором.
 * Хвост, не похожий на локатор («a:b.ts», «src/db.ts:abc»), оставляет строку
 * как есть — двоеточие может быть частью имени.
 */
function splitFileLocator(ref: string): { path: string; locator: string | null } {
  const colon = ref.lastIndexOf(":");
  if (colon > 1) {
    const tail = ref.slice(colon + 1);
    if (LINE_RANGE_RE.test(tail)) {
      return { path: ref.slice(0, colon), locator: tail };
    }
  }
  const hash = ref.lastIndexOf("#");
  if (hash > 0) {
    const m = ref.slice(hash + 1).match(L_LOCATOR_RE);
    if (m) {
      return { path: ref.slice(0, hash), locator: m[2] ? `${m[1]}-${m[2]}` : m[1] };
    }
  }
  return { path: ref, locator: null };
}

export interface ParsedRef {
  /** "git" — схема git (или blob-форма), path = raw, ничего не отрезано. */
  kind: "file" | "git";
  /**
   * Для file — путь для файловой системы (локатор снят); для git — сырая
   * ссылка целиком.
   */
  path: string;
  /** Нормализованный локатор «12» / «12-30»; null — локатора нет. */
  locator: string | null;
  /** Сырая строка, как записал агент. */
  raw: string;
}

/**
 * Единственный разбор ссылки. Git-формы проверяются первыми (classifyRef) —
 * «git:tag:2026» не превращается в путь «git:tag» с локатором «2026».
 */
export function parseRef(ref: string): ParsedRef {
  if (classifyRef(ref).kind !== "file") {
    return { kind: "git", path: ref, locator: null, raw: ref };
  }
  const { path, locator } = splitFileLocator(ref);
  return { kind: "file", path, locator, raw: ref };
}
