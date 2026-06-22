import { z } from 'zod';

// Typed worker-output contracts. `spin complete --handoff` validates a worker's
// JSON sidecar against one of these BEFORE the artifact counts as done. This is
// the seam that makes "the LLM self-marked it done" impossible.

export const DefineHandoff = z.object({
  feature: z.string().min(1),
  clarity: z.number().min(0).max(1),
  criteria: z
    .array(
      z
        .string()
        // Custom message so a wrong shape reads as guidance, not a bare "Invalid"
        // (dogfood run #2, G1): the prose AC belongs in DEFINE.md; this array holds
        // bare IDs only.
        .regex(/^AC-\d+$/, 'expected a bare acceptance-criterion id like "AC-1" (no prose, colon, or spaces)')
    )
    .min(1, 'at least one acceptance criterion'),
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
        // Spec-drift signal (dogfood F6): set when the build implemented this
        // criterion DIFFERENTLY from the value DEFINE stated, because DEFINE was
        // wrong (e.g. AC-1 said CRC "1D3D", the real value is "29B1"). Forces the
        // correction to be EXPLICIT instead of buried in a code comment — so a
        // green build can't silently leave a false spec behind.
        corrected_spec: z.boolean().default(false),
        correction: z.string().optional(), // what was wrong + the right value
        // Set true once DEFINE.md has been updated to the correct value (dogfood
        // run #2, G2). `spin spec-drift` ignores a reconciled correction, so the
        // ship loop converges instead of exiting 1 forever after the fix.
        reconciled: z.boolean().default(false),
        // Optional evidence for a `passed` status: the test file / check that
        // substantiates it. When it looks like a path, G_BUILD requires the file
        // to exist — so "passed" can carry proof, not just a bare assertion.
        verified_by: z.string().optional(),
      })
    )
    .default([]),
  files_written: z.array(z.string()).default([]),
  // Optional coverage summary — populated by CI after the test run.
  // Purely additive; existing build-report handoffs without this field remain valid.
  coverage: z
    .object({
      tool: z.string().min(1),        // e.g. "vitest", "jest", "pytest-cov"
      pct: z.number().min(0).max(100), // measured coverage percentage
      threshold: z.number().min(0).max(100), // project's required minimum
    })
    .optional(),
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
  // E-1 honesty: when a worker flags an opaque encoding it must say WHAT is
  // undecoded, not just raise the flag. Optional at the schema layer (additive);
  // gKbCoverage enforces note-required-iff-needs_decoding so the block names the
  // offending concept.
  decoding_note: z.string().optional(),
});

// AuditHandoff — the typed worker-output for the brownfield `audit` artifact.
// Consolidates the dogfood improvements: structured evidence + 3-value severity
// (I2), doc-vs-code reconciliation fields (I3), ops-readiness bucket (I4),
// proposedTasks as the typed audit->define bridge with cross-domain deps (I7),
// invariants-at-risk (I10) and test tiers (I9). Each `built[]` item must carry
// evidence (files + proof) so a claim of "done" cannot be a bare prose assertion
// — G_AUDIT enforces that.
export const AuditHandoff = z.object({
  domain: z.string().min(1),
  built: z
    .array(
      z.object({
        item: z.string().min(1),
        evidence: z.object({
          files: z.array(z.string()).default([]),
          lines: z.string().optional(),
          proof: z.string().default(''),
        }),
        status: z.enum(['proven', 'partial', 'scaffolded']),
        resolved_at_commit: z.string().nullish(), // commit that resolved it, or null/omitted
        verified_in_code: z.boolean().default(false),
      })
    )
    .default([]),
  gaps: z
    .array(
      z.object({
        capability: z.string().min(1),
        why: z.string().min(1),
        priority: z.enum(['blocking', 'important', 'nice-to-have']),
      })
    )
    .default([]),
  weakPoints: z
    .array(
      z.object({
        item: z.string().min(1),
        severity: Severity,
        evidence: z.string().min(1),
      })
    )
    .default([]),
  opsReadiness: z
    .array(
      z.object({
        control: z.string().min(1),
        code_default: z.string(),
        prod_value_required: z.string(),
        env_files_checked: z.array(z.string()).default([]),
        enforced: z.boolean(),
      })
    )
    .default([]),
  proposedTasks: z
    .array(
      z.object({
        title: z.string().min(1),
        detail: z.string(),
        effort: z.enum(['S', 'M', 'L', 'XL']),
        dependsOn: z.string().optional(),
        external_preconditions: z.array(z.string()).default([]),
        domains: z.array(z.string()).default([]),
      })
    )
    .default([]),
  invariants_at_risk: z.array(z.string()).default([]),
  test_tiers: z
    .object({
      unit: z.string(),
      infra_bound: z.string(),
    })
    .optional(),
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
  audit: AuditHandoff,
} as const;

export type HandoffId = keyof typeof HANDOFF_SCHEMAS;

export function isHandoffId(id: string): id is HandoffId {
  return Object.prototype.hasOwnProperty.call(HANDOFF_SCHEMAS, id);
}
