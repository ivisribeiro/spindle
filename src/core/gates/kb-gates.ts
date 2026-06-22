import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { type GateContext, type GateResult, pass, block } from './types.js';
import { checkHandoffFile } from '../handoff/handoff-check.js';

// KB gates — replace create-kb's blind delegation to kb-architect with concrete
// structural + coverage checks over the generated domain.

// Manifest shape is enforced HERE (not by `spin validate manifest`, which only
// checks existence). The slug regex matches the flat concept-<slug>.md contract the
// kb-concept worker produces — no slashes/dots, so a slug cannot smuggle a subdir.
const KbSlug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case [a-z0-9-], no slash or dot');
export const KbManifestSchema = z
  .object({ concepts: z.array(z.object({ slug: KbSlug })).min(1, 'manifest needs >=1 concept') })
  .strict();
export type KbManifest = z.infer<typeof KbManifestSchema>;

function loadManifest(dir: string): { ok: true; data: KbManifest } | { ok: false; errors: string[] } {
  const manifestPath = path.join(dir, 'manifest.json');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return { ok: false, errors: [`manifest.json missing or invalid JSON: ${manifestPath}`] };
  }
  const parsed = KbManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`) };
  }
  return { ok: true, data: parsed.data };
}

function exists(p: string | null): boolean {
  return !!p && fs.existsSync(p);
}

/** G_KB_STRUCTURE — domain has the required scaffolding + at least one concept. */
export function gKbStructure(ctx: GateContext): GateResult {
  const gate = 'G_KB_STRUCTURE';
  const dir = ctx.featureDir;
  if (!dir || !fs.existsSync(dir)) {
    return block(gate, [`KB domain dir not found: ${dir ?? '(unset)'}`], ['domain-dir']);
  }
  const reasons: string[] = [];
  const unmet: string[] = [];

  for (const required of ['index.md', 'quick-reference.md', 'manifest.json']) {
    if (!exists(path.join(dir, required))) {
      reasons.push(`missing ${required}`);
      unmet.push(required);
    }
  }
  const conceptFiles = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.startsWith('concept-') && f.endsWith('.md'))
    : [];
  if (conceptFiles.length === 0) {
    reasons.push('no concept files (concept-*.md)');
    unmet.push('concepts');
  }
  // Validate manifest SHAPE if present (existence is checked above) so a malformed
  // manifest blocks at the 'during' gate too, not just at coverage.
  if (exists(path.join(dir, 'manifest.json'))) {
    const loaded = loadManifest(dir);
    if (!loaded.ok) {
      reasons.push(...loaded.errors);
      unmet.push('manifest-shape');
    }
  }

  return unmet.length === 0 ? pass(gate, ['KB structure complete']) : block(gate, reasons, unmet);
}

/** G_KB_COVERAGE — every manifest concept has a file + enough test cases. */
export function gKbCoverage(ctx: GateContext): GateResult {
  const gate = 'G_KB_COVERAGE';
  const dir = ctx.featureDir;
  if (!dir || !fs.existsSync(dir)) {
    return block(gate, [`KB domain dir not found: ${dir ?? '(unset)'}`], ['domain-dir']);
  }
  const loaded = loadManifest(dir);
  if (!loaded.ok) {
    return block(gate, loaded.errors, ['manifest-shape']);
  }
  const concepts = loaded.data.concepts;
  const minCases = ctx.runState && ctx.graph ? (ctx.graph.getSchema().config?.kb_min_test_cases ?? 1) : 1;

  const reasons: string[] = [];
  const unmet: string[] = [];
  for (const { slug } of concepts) {
    const conceptFile = path.join(dir, `concept-${slug}.md`);
    if (!exists(conceptFile)) {
      reasons.push(`concept declared but not authored: ${slug}`);
      unmet.push(`concept:${slug}`);
      continue;
    }
    if (ctx.handoffDir) {
      const hPath = path.join(ctx.handoffDir, `kb-concept-${slug}.json`);
      const check = checkHandoffFile('kb-concept', hPath);
      if (!check.ok) {
        reasons.push(`concept "${slug}" handoff invalid: ${check.errors.join('; ')}`);
        unmet.push(`handoff:${slug}`);
      } else {
        const data = check.data as {
          test_cases?: string[];
          needs_decoding?: boolean;
          decoding_note?: string;
        };
        if ((data.test_cases?.length ?? 0) < minCases) {
          reasons.push(`concept "${slug}" has fewer than ${minCases} test case(s)`);
          unmet.push(`test-cases:${slug}`);
        }
        // E-1 honesty: a concept that flags needs_decoding must carry a non-empty
        // decoding_note saying what is undecoded.
        if (data.needs_decoding === true && !(data.decoding_note ?? '').trim()) {
          reasons.push(`concept "${slug}" sets needs_decoding=true but has no decoding_note (E-1)`);
          unmet.push(`e1-decoding-note:${slug}`);
        }
      }
    }
  }

  return unmet.length === 0
    ? pass(gate, [`all ${concepts.length} concepts covered`])
    : block(gate, reasons, unmet);
}
