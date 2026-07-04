// Minimal, dependency-free check of the running Node version against an
// `engines.node` range string (e.g. from package.json). This is NOT a general
// semver-range implementation — it covers the single-clause forms that actually
// appear in engines fields (">=18", "^18.0.0", "~18.2.0", "18", "18.2.0"). A
// compound range ("13 - 15", "14 || 16") is reported as unparseable (satisfies:
// null) rather than guessed at.

export interface NodeVersionCheck {
  /** `process.version`, e.g. "v20.11.0". */
  version: string;
  /** The declared range, or null when none was found. */
  required: string | null;
  /** null when `required` is absent or not a form this parser understands. */
  satisfies: boolean | null;
}

type Triple = [number, number, number];

type RangeOp = '>=' | '>' | '<=' | '<' | '^' | '~' | '=';

interface ParsedRange {
  op: RangeOp;
  /** Which components the range actually specified (for '=' equality width). */
  precision: 1 | 2 | 3;
  value: Triple;
}

function parseTriple(v: string): Triple {
  const m = v.replace(/^v/, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compareTriples(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function parseRange(range: string): ParsedRange | null {
  const m = range.trim().match(/^(>=|<=|>|<|\^|~)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/);
  if (!m) return null;
  const op = (m[1] ?? '=') as RangeOp;
  const precision: 1 | 2 | 3 = m[4] !== undefined ? 3 : m[3] !== undefined ? 2 : 1;
  const value: Triple = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
  return { op, precision, value };
}

/** Compare `current` against `parsed`, honoring the equality precision (a
 *  major-only "18" matches any 18.x.y under '='). */
function matches(current: Triple, parsed: ParsedRange): boolean {
  switch (parsed.op) {
    case '>=':
      return compareTriples(current, parsed.value) >= 0;
    case '>':
      return compareTriples(current, parsed.value) > 0;
    case '<=':
      return compareTriples(current, parsed.value) <= 0;
    case '<':
      return compareTriples(current, parsed.value) < 0;
    case '^':
      // Caret: same major, at least the given version.
      return current[0] === parsed.value[0] && compareTriples(current, parsed.value) >= 0;
    case '~':
      // Tilde: same major.minor, at least the given patch.
      return (
        current[0] === parsed.value[0] &&
        current[1] === parsed.value[1] &&
        current[2] >= parsed.value[2]
      );
    case '=':
      if (parsed.precision === 1) return current[0] === parsed.value[0];
      if (parsed.precision === 2) return current[0] === parsed.value[0] && current[1] === parsed.value[1];
      return compareTriples(current, parsed.value) === 0;
  }
}

export function checkNodeVersion(
  currentVersion: string,
  requiredRange: string | null | undefined
): NodeVersionCheck {
  if (!requiredRange) return { version: currentVersion, required: null, satisfies: null };
  const parsed = parseRange(requiredRange);
  if (!parsed) return { version: currentVersion, required: requiredRange, satisfies: null };
  const current = parseTriple(currentVersion);
  return { version: currentVersion, required: requiredRange, satisfies: matches(current, parsed) };
}
