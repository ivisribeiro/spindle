// Structural markdown validation: assert required "## Section" headers exist and
// have non-empty bodies. Used by `spin validate` and the SDD gates. Deterministic.

export interface SectionIssue {
  section: string;
  problem: 'missing' | 'empty';
}

interface ParsedSection {
  title: string;
  body: string;
}

/** Splits markdown into level-2 (##) sections. Body excludes the header line. */
export function parseSections(markdown: string): ParsedSection[] {
  const lines = markdown.split('\n');
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match && !line.startsWith('###')) {
      if (current) sections.push(current);
      current = { title: match[1].trim(), body: '' };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current) sections.push(current);
  return sections;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** Returns the issues for required sections (missing or empty). Empty array = pass. */
export function validateSections(markdown: string, required: string[]): SectionIssue[] {
  const sections = parseSections(markdown);
  const byTitle = new Map(sections.map((s) => [normalize(s.title), s]));
  const issues: SectionIssue[] = [];

  for (const req of required) {
    const found = byTitle.get(normalize(req));
    if (!found) {
      issues.push({ section: req, problem: 'missing' });
    } else if (found.body.trim().length === 0) {
      issues.push({ section: req, problem: 'empty' });
    }
  }
  return issues;
}

/** True if the markdown contains at least one GitHub-style table (| --- | row). */
export function hasManifestTable(markdown: string): boolean {
  return /\n\s*\|.*\|\s*\n\s*\|[\s:|-]+\|\s*\n/.test('\n' + markdown + '\n');
}

/** Extracts stable criteria IDs (e.g. AC-1, AC-12) with a given prefix. */
export function extractCriteriaIds(markdown: string, prefix: string): string[] {
  const re = new RegExp(`\\b${prefix}-\\d+\\b`, 'g');
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    found.add(m[0]);
  }
  return Array.from(found).sort();
}

// ---------------------------------------------------------------------------
// Content lints — beyond "the section exists and is non-empty".
//
// `validateSections` proves a heading has a body. It cannot tell a real
// acceptance criterion from `AC-1: TBD`. These three lints close that gap.
// Only the placeholder lint is wired to a blocking verdict (inside G_DEFINE,
// scoped to the Acceptance Criteria body, where a stub token is unambiguously
// not a criterion). The other two are ADVISORY — reported in `spin validate`
// output without touching its exit code, the same contract `handoff-check`
// uses for `unknown_keys`.
//
// origin: boostprompt (MIT) — the self-containment and reference-URL lints are
// adapted from its PromptArtifactValidator. See CREDITS.md.
// ---------------------------------------------------------------------------

/** Stub tokens that mean "not written yet". Deliberately unambiguous — no `...`, no `<var>`. */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\bTBD\b/gi,
  /\bTODO\b/gi,
  /\bFIXME\b/gi,
  /\bXXX\b/g,
  /\?{3,}/g,
  /\blorem ipsum\b/gi,
  /\bto be (defined|determined|decided)\b/gi,
  /\ba definir\b/gi,
  /\bpreencher\b/gi,
];

/** Distinct placeholder tokens found in `text`. Empty = no stubs. */
export function findPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of PLACEHOLDER_PATTERNS) {
    for (const match of text.matchAll(pattern)) found.add(match[0].toLowerCase());
  }
  return Array.from(found).sort();
}

/**
 * Phrases that make an artifact depend on a document it does not carry. A handoff
 * artifact is read by a worker that has none of the surrounding conversation, so
 * "as described above" resolves to nothing.
 */
const DANGLING_REFERENCE_PATTERNS: RegExp[] = [
  /\bas (described|shown|defined|mentioned|stated) (above|below|earlier|previously)\b/gi,
  /\bsee (the )?(document|section|prompt|spec|scope)? ?(above|below)\b/gi,
  /\bthe (document|prompt|scope|spec) (above|below)\b/gi,
  /\b(documento|prompt|escopo) (acima|abaixo)\b/gi,
  /\bconforme (acima|abaixo)\b/gi,
];

/** Distinct dangling cross-references found. Advisory. */
export function findDanglingReferences(markdown: string): string[] {
  const found = new Set<string>();
  for (const pattern of DANGLING_REFERENCE_PATTERNS) {
    for (const match of markdown.matchAll(pattern)) found.add(match[0].toLowerCase());
  }
  return Array.from(found).sort();
}

function isResolvableHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Reference-shaped tokens that do not resolve to an http(s) URL with a host.
 * Only checks things that INTEND to be a URL (a bare `http(s)://…` occurrence, or
 * an explicit `URL:` line) — a relative markdown link is not a citation and is
 * never flagged. Advisory.
 */
export function findInvalidUrls(markdown: string): string[] {
  const candidates = new Set<string>();
  for (const match of markdown.matchAll(/^\s*URL:\s*(\S+)\s*$/gim)) candidates.add(match[1]);
  for (const match of markdown.matchAll(/https?:\/\/\S*/g)) {
    candidates.add(match[0].replace(/[).,;\]]+$/, ''));
  }
  return Array.from(candidates)
    .filter((c) => !isResolvableHttpUrl(c))
    .sort();
}
