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
