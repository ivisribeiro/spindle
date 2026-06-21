import { z } from 'zod';

// Typed worker-output contracts. `spin complete --handoff` validates a worker's
// JSON sidecar against one of these BEFORE the artifact counts as done. This is
// the seam that makes "the LLM self-marked it done" impossible.

export const DefineHandoff = z.object({
  feature: z.string().min(1),
  clarity: z.number().min(0).max(1),
  criteria: z.array(z.string().regex(/^AC-\d+$/)).min(1, 'at least one acceptance criterion'),
  open_questions: z.array(z.string()).default([]),
});

export const DesignHandoff = z.object({
  feature: z.string().min(1),
  manifest: z
    .array(
      z.object({
        file: z.string().min(1),
        action: z.enum(['create', 'modify', 'delete']),
        purpose: z.string().min(1),
      })
    )
    .min(1, 'manifest must list at least one file'),
  decisions: z.array(z.string()).default([]),
});

export const BuildTaskHandoff = z.object({
  file: z.string().min(1),
  verification_passed: z.boolean(),
  retry_count: z.number().int().nonnegative().default(0),
  criteria_satisfied: z.array(z.string().regex(/^AC-\d+$/)).default([]),
  issues: z.array(z.string()).default([]),
});

export const BuildReportHandoff = z.object({
  feature: z.string().min(1),
  results: z
    .array(
      z.object({
        criterion: z.string().regex(/^AC-\d+$/),
        status: z.enum(['passed', 'failed', 'skipped']),
      })
    )
    .default([]),
  files_written: z.array(z.string()).default([]),
});

export const Severity = z.enum(['critical', 'high', 'medium', 'low']);

// NOTE: `findings` is REQUIRED (no default). A findings file that omits the key
// must fail loudly — otherwise a malformed `{...}` would validate as `{findings:[]}`
// and G_REVIEW_BLOCK would silently pass a dropped CRITICAL.
export const FindingHandoff = z.object({
  findings: z.array(
    z.object({
      file: z.string().min(1),
      line: z.number().int().nonnegative().nullish(), // number, null (unknown line), or omitted
      severity: Severity,
      rule: z.string().min(1),
      message: z.string().min(1),
      source: z.string().min(1), // which worker / tool produced it
    })
  ),
});

export const ClaimHandoff = z.object({
  claims: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        verified: z.boolean().optional(),
        verdict: z.enum(['true', 'false', 'unverifiable']).optional(),
        evidence: z.string().optional(),
      })
    )
    .default([]),
});

export const MigrationPlanHandoff = z.object({
  engine: z.enum(['dbt', 'spark', 'sql', 'other']),
  steps: z.array(z.string()).min(1),
  risks: z.array(z.string()).default([]),
  rollback: z.string().min(1),
});

export const ClaudeMdSectionHandoff = z.object({
  section: z.string().min(1),
  strategy: z.enum(['preserve', 'replace', 'merge']),
  content: z.string(),
});

export const KbConceptHandoff = z.object({
  concept: z.string().min(1),
  summary: z.string().min(1),
  test_cases: z.array(z.string()).default([]),
  needs_decoding: z.boolean().default(false),
});

// Registry: handoff id -> Zod schema. The schema.yaml `handoff:` field names one.
export const HANDOFF_SCHEMAS = {
  define: DefineHandoff,
  design: DesignHandoff,
  'build-task': BuildTaskHandoff,
  'build-report': BuildReportHandoff,
  finding: FindingHandoff,
  claim: ClaimHandoff,
  'migration-plan': MigrationPlanHandoff,
  'claudemd-section': ClaudeMdSectionHandoff,
  'kb-concept': KbConceptHandoff,
} as const;

export type HandoffId = keyof typeof HANDOFF_SCHEMAS;

export function isHandoffId(id: string): id is HandoffId {
  return Object.prototype.hasOwnProperty.call(HANDOFF_SCHEMAS, id);
}
