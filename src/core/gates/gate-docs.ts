import { GATE_REGISTRY, listGates } from './registry.js';

// Declarative, machine-readable documentation for every gate — what it READS,
// what BLOCKS it, and which CLI flags apply. This closes dogfood friction F2:
// before this, an agent had to read the gate source (sdd-gates.ts, audit-gate.ts)
// to learn that, e.g., G_DEFINE also needs a `.handoffs/define.json` sidecar and
// takes no flags. `spin explain <GATE>` now answers that without source-diving.
//
// INVARIANT (asserted in gate-docs.test.ts): every id in GATE_REGISTRY has a doc,
// and no doc names a gate that isn't registered. So this can't silently drift.

export interface GateDoc {
  gate: string;
  purpose: string;
  /** Inputs the gate consumes, in plain terms. */
  reads: string[];
  /** The handoff schema id it validates, if any — point users at `spin schema show <id>`. */
  handoff?: string;
  /** What makes the gate exit 1. */
  blocks_when: string[];
  /** CLI flags that apply. Empty = the gate reads from the standard on-disk paths and takes NO flags. */
  flags: string[];
}

export const GATE_DOCS: Record<string, GateDoc> = {
  G_DEFINE: {
    gate: 'G_DEFINE',
    purpose: 'Gate before /design: the requirements artifact is structurally complete.',
    reads: [
      'DEFINE.md in the feature dir (sections: ## Why, ## What, ## Acceptance Criteria)',
      'the canonical .handoffs/define.json sidecar (written by `spin complete define --handoff`)',
    ],
    handoff: 'define',
    blocks_when: [
      'DEFINE.md missing on disk',
      'any required ## section absent or empty',
      'define handoff missing or invalid against the DefineHandoff schema',
    ],
    flags: [],
  },
  G_DESIGN: {
    gate: 'G_DESIGN',
    purpose: 'Gate before /build: the technical design + file manifest are present.',
    reads: [
      'DESIGN.md (sections: ## Overview, ## File Manifest, ## Decisions) + a markdown manifest table',
      'the canonical .handoffs/design.json sidecar',
    ],
    handoff: 'design',
    blocks_when: [
      'DESIGN.md missing on disk',
      'any required ## section absent or empty',
      'no file-manifest table found',
      'design handoff invalid against the DesignHandoff schema',
    ],
    flags: [],
  },
  G_BUILD: {
    gate: 'G_BUILD',
    purpose: 'Gate before /ship: every manifest file exists and every acceptance criterion is satisfied.',
    reads: [
      'BUILD_REPORT.md in the feature dir',
      '.handoffs/design.json (each manifest file must exist on disk, repo-relative)',
      '.handoffs/define.json (the acceptance criteria) and .handoffs/build.json (the build results)',
    ],
    handoff: 'build-report',
    blocks_when: [
      'BUILD_REPORT.md missing',
      'a file from the design manifest was not built',
      'an acceptance criterion from DEFINE is not marked passed in the build results',
      'the build certifies a criterion DEFINE never declared (phantom/set-drift)',
      'a passed criterion cites a verified_by file (path) that does not exist on disk',
    ],
    flags: [],
  },
  G_SHIP: {
    gate: 'G_SHIP',
    purpose: 'Final certification inside /ship: define.criteria minus build.passed must be empty.',
    reads: ['.handoffs/define.json (criteria)', '.handoffs/build.json (results, incl. corrected_spec flags)'],
    handoff: 'build-report',
    blocks_when: [
      'any acceptance criterion in DEFINE is not satisfied by the build results',
      'the build certifies a criterion DEFINE never declared (phantom/set-drift)',
    ],
    flags: [],
  },
  G_KB_STRUCTURE: {
    gate: 'G_KB_STRUCTURE',
    purpose: 'KB domain has the required scaffolding and at least one concept.',
    reads: ['the KB domain dir: index.md, quick-reference.md, manifest.json, and concept-*.md files'],
    blocks_when: ['index.md / quick-reference.md / manifest.json missing', 'no concept-*.md files'],
    flags: [],
  },
  G_KB_COVERAGE: {
    gate: 'G_KB_COVERAGE',
    purpose: 'Every concept the manifest promises has a file and enough test_cases.',
    reads: ['manifest.json (the promised concepts)', 'each concept-*.md and its kb-concept handoff'],
    handoff: 'kb-concept',
    blocks_when: ['a manifest concept has no file', 'a concept has fewer than the required test_cases'],
    flags: [],
  },
  G_ROUTER_COVERAGE: {
    gate: 'G_ROUTER_COVERAGE',
    purpose:
      'Bijection between the agent roster and the routing table, plus kb_domains referential integrity — no silent skips.',
    reads: [
      'the agents dir (--agents)',
      'the routing.json (--routing)',
      'the kb dir (--kb, default plugin/kb) for declared kb_domains',
    ],
    blocks_when: [
      'an agent frontmatter fails to parse',
      'an agent is missing from routing, or routing lists an agent that does not exist',
      'an agent declares a kb_domain with no matching <kb>/<domain>/ dir (referential integrity, not usage proof)',
    ],
    flags: ['--agents <dir> (required)', '--routing <file> (required)', '--kb <dir> (optional; default plugin/kb)'],
  },
  G_REVIEW_BLOCK: {
    gate: 'G_REVIEW_BLOCK',
    purpose: 'Block on surviving CRITICAL findings after the adversarial pass (shared by /review, /migrate).',
    reads: ['the findings.json (--findings), validated as a Finding[]'],
    handoff: 'finding',
    blocks_when: [
      'any finding with severity "critical" survives',
      'the findings file has the wrong shape (not an object with a "findings" array)',
    ],
    flags: ['--findings <file> (required)'],
  },
  G_AUDIT: {
    gate: 'G_AUDIT',
    purpose: 'The brownfield audit inventory is evidence-backed (built items prove themselves).',
    reads: ['the audit handoff: --handoff <file>, else .handoffs/audit.json'],
    handoff: 'audit',
    blocks_when: [
      'an empty audit (zero built AND zero gaps)',
      'a built[] item missing evidence.files or evidence.proof',
      'a gap without a valid priority',
    ],
    flags: ['--handoff <file> (optional; defaults to .handoffs/audit.json)'],
  },
  G_OPS_CONFIG: {
    gate: 'G_OPS_CONFIG',
    purpose: 'No ops-readiness control is "coded but inert in prod" (enforced=false).',
    reads: ['the audit handoff opsReadiness[]: --audit <file>, else .handoffs/audit.json'],
    handoff: 'audit',
    blocks_when: ['any opsReadiness item has enforced=false (a flag coded but off in prod)'],
    flags: ['--audit <file> (optional; defaults to .handoffs/audit.json)'],
  },
  G_PLAN: {
    gate: 'G_PLAN',
    purpose: 'Plan quality: no vague task, no over-bundled task, no orphaned blocking gap.',
    reads: ['the audit handoff proposedTasks[] + gaps[]: --audit <file>, else .handoffs/audit.json'],
    handoff: 'audit',
    blocks_when: [
      'a task whose detail has no falsifiable signal (no file-path or command token)',
      'an L/XL task spanning more than one domain',
      'a "blocking" gap addressed by no proposed task',
    ],
    flags: ['--audit <file> (optional; defaults to .handoffs/audit.json)'],
  },
};

export function explainGate(id: string): GateDoc | null {
  return GATE_DOCS[id] ?? null;
}

/** Every registered gate must have a doc, and vice versa. Keeps explain honest. */
export function gateDocsCoverage(): { undocumented: string[]; orphaned: string[] } {
  const registered = new Set(Object.keys(GATE_REGISTRY));
  const documented = new Set(Object.keys(GATE_DOCS));
  return {
    undocumented: listGates().filter((g) => !documented.has(g)),
    orphaned: [...documented].filter((g) => !registered.has(g)).sort(),
  };
}
