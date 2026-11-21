// ---- Version ordering for the instructions stamp (plan 32) ----
//
// instructionsStatus used to compare stamp and server versions for INEQUALITY,
// so "block newer than server" (the client was updated first, the server in
// the open session is still the old build) fired the same stale warning as a
// genuinely outdated block — and the prescribed `install` could not clear it
// (install is idempotent, the stamp stays the same). The only direction the
// signal is true for is the block OLDER than the running server, and that one
// must survive. Ordering, not equality, tells the directions apart.

export type VersionOrder = -1 | 0 | 1;

/** Three numeric core segments plus the optional prerelease identifiers. */
interface ParsedVersion {
  core: [number, number, number];
  pre: string[];
}

/**
 * semver core: exactly three numeric segments, optional prerelease after a
 * hyphen (dot-separated identifiers of digits/letters/hyphens, none empty —
 * an empty identifier is a broken form, not a prerelease).
 */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * null — the version does not parse (NOT "equal"): an unrecognizable form is
 * treated conservatively by the caller as outdated. Everything else follows
 * the plan-32 rules, semver-compatible for the forms that actually occur —
 * `2.12.3`, `2.0.0-fork.1`, `2.12.3-rc.1`:
 * 1. leading `v` and surrounding whitespace are stripped;
 * 2. the core is three numeric segments; anything else -> null;
 * 3. major/minor/patch compare numerically;
 * 4. equal core: a version without prerelease outranks one with it;
 * 5. both prerelease — identifier by identifier: numeric ones numerically,
 *    alphanumeric lexically, numeric identifier below alphanumeric (semver §11);
 * 6. build metadata (`+build`) is discarded before comparison.
 */
export function compareVersions(a: string, b: string): VersionOrder | null {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) {
    // Release (no prerelease) > prerelease; two releases of the same core are equal.
    if (pa.pre.length === pb.pre.length) return 0;
    return pa.pre.length === 0 ? 1 : -1;
  }
  const length = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < length; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    // The shorter identifier set ranks lower once the common prefix is equal.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const order = compareIdentifiers(x, y);
    if (order !== 0) return order;
  }
  return 0;
}

function parse(version: string): ParsedVersion | null {
  const stripped = version.trim().replace(/^v/, "").split("+")[0];
  const match = stripped.match(VERSION_RE);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(a: string, b: string): VersionOrder {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  if (aNumeric && bNumeric) {
    // Числовые идентификаторы — как числа: ведущие нули и «10 > 2», а не «10 < 9».
    const na = Number(a);
    const nb = Number(b);
    if (na !== nb) return na < nb ? -1 : 1;
    return 0;
  }
  if (a !== b) return a < b ? -1 : 1;
  return 0;
}
