import * as fs from 'node:fs';
import * as path from 'node:path';
import { type GateContext, type GateResult, pass, block } from './types.js';
import { validateSections, hasManifestTable } from '../validation/md-section-validator.js';
import { criteriaDiff } from '../validation/criteria-diff.js';
import { checkHandoffFile } from '../handoff/handoff-check.js';
import { specDrift } from '../spec-drift.js';

// The SDD gates. These replace AgentSpec build.md's prose "max 3 retry" and the
// self-marked checkbox quality gate with deterministic, testable checks.

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function handoffPath(ctx: GateContext, id: string): string | null {
  if (!ctx.handoffDir) return null;
  return path.join(ctx.handoffDir, `${id}.json`);
}

function artifactMdPath(ctx: GateContext, id: string): string | null {
  if (!ctx.graph || !ctx.featureDir) return null;
  const artifact = ctx.graph.getArtifact(id);
  if (!artifact) return null;
  return path.join(ctx.featureDir, artifact.generates);
}

const REQUIRED_DEFINE_SECTIONS = ['Why', 'What', 'Acceptance Criteria'];
const REQUIRED_DESIGN_SECTIONS = ['Overview', 'File Manifest', 'Decisions'];

/** G_DEFINE — before /design. */
export function gDefine(ctx: GateContext): GateResult {
  const gate = 'G_DEFINE';
  const reasons: string[] = [];
  const unmet: string[] = [];

  const mdPath = artifactMdPath(ctx, 'define');
  const md = mdPath ? readIfExists(mdPath) : null;
  if (md === null) {
    return block(gate, ['DEFINE artifact not found on disk'], ['DEFINE.md']);
  }
  const sectionIssues = validateSections(md, REQUIRED_DEFINE_SECTIONS);
  for (const issue of sectionIssues) {
    reasons.push(`section "${issue.section}" ${issue.problem}`);
    unmet.push(`section:${issue.section}`);
  }

  const hPath = handoffPath(ctx, 'define');
  if (!hPath) {
    reasons.push('no handoff dir configured');
    unmet.push('handoff:define');
  } else {
    const check = checkHandoffFile('define', hPath);
    if (!check.ok) {
      reasons.push(`define handoff invalid: ${check.errors.join('; ')}`);
      unmet.push('handoff:define');
    } else {
      // Optional config-driven clarity floor: turn the recorded 0..1 clarity into a
      // verdict when the schema declares a floor. UNSET => not enforced (additive).
      const floor = ctx.graph?.getSchema().config?.clarity_floor;
      const clarity = (check.data as { clarity?: number }).clarity;
      if (typeof floor === 'number' && typeof clarity === 'number' && clarity < floor) {
        reasons.push(`clarity ${clarity} is below the configured floor ${floor}`);
        unmet.push('clarity-floor');
      }
    }
  }

  return unmet.length === 0 ? pass(gate, ['define complete']) : block(gate, reasons, unmet);
}

/** G_DESIGN — before /build. */
export function gDesign(ctx: GateContext): GateResult {
  const gate = 'G_DESIGN';
  const reasons: string[] = [];
  const unmet: string[] = [];

  const mdPath = artifactMdPath(ctx, 'design');
  const md = mdPath ? readIfExists(mdPath) : null;
  if (md === null) {
    return block(gate, ['DESIGN artifact not found on disk'], ['DESIGN.md']);
  }
  for (const issue of validateSections(md, REQUIRED_DESIGN_SECTIONS)) {
    reasons.push(`section "${issue.section}" ${issue.problem}`);
    unmet.push(`section:${issue.section}`);
  }
  if (!hasManifestTable(md)) {
    reasons.push('DESIGN has no file-manifest table');
    unmet.push('manifest-table');
  }

  const hPath = handoffPath(ctx, 'design');
  if (hPath) {
    const check = checkHandoffFile('design', hPath);
    if (!check.ok) {
      reasons.push(`design handoff invalid: ${check.errors.join('; ')}`);
      unmet.push('handoff:design');
    }
  }

  return unmet.length === 0 ? pass(gate, ['design complete']) : block(gate, reasons, unmet);
}

interface DesignManifest {
  manifest?: Array<{ file: string }>;
}
interface DefineCriteria {
  criteria?: string[];
}
interface BuildResults {
  results?: Array<{
    criterion: string;
    status: string;
    corrected_spec?: boolean;
    correction?: string;
    reconciled?: boolean;
    verified_by?: string;
  }>;
}

/**
 * A verified_by value worth existence-checking on disk: a single POSIX repo-relative
 * path token. Everything else is ACCEPTED WITHOUT a check rather than false-blocked —
 * a command has a space ("npm run e2e"), a URL has a scheme ("http://…"), a Windows
 * path has a backslash/drive ("C:\\…", "src\\a"), and a bare version is a dotted
 * NUMBER ("v1.2", "1.0"). Only a separator or a real (letter-led) file extension on
 * an otherwise plain token counts. (dogfood: adversary-confirmed false-block vectors.)
 */
function looksLikePath(v: string): boolean {
  if (v.includes(' ')) return false; // command
  if (v.includes('://')) return false; // URL citation
  if (v.includes('\\')) return false; // Windows path — not a POSIX repo path
  if (/^[a-zA-Z]:/.test(v)) return false; // Windows drive letter
  // extension must start with a LETTER, so "v1.2" / "1.0" are not read as paths
  return v.includes('/') || /\.[a-z][a-z0-9]{0,5}$/i.test(v);
}

/** G_BUILD — before /ship. Replaces the prose checkbox + max-3-retry. */
export function gBuild(ctx: GateContext): GateResult {
  const gate = 'G_BUILD';
  const reasons: string[] = [];
  const unmet: string[] = [];

  // 1. BUILD_REPORT must exist.
  const reportPath = artifactMdPath(ctx, 'build');
  if (!reportPath || readIfExists(reportPath) === null) {
    reasons.push('BUILD_REPORT missing');
    unmet.push('BUILD_REPORT.md');
  }

  // 2. Every manifest file from the design handoff must exist on disk (repo-relative).
  const designHandoff = handoffPath(ctx, 'design');
  const design = designHandoff ? safeJson<DesignManifest>(designHandoff) : null;
  if (design?.manifest) {
    for (const entry of design.manifest) {
      const target = path.join(ctx.root, entry.file);
      if (!fs.existsSync(target)) {
        reasons.push(`manifest file not built: ${entry.file}`);
        unmet.push(entry.file);
      }
    }
  } else {
    reasons.push('design handoff/manifest unavailable — cannot verify build outputs');
    unmet.push('handoff:design');
  }

  // 3. Acceptance criteria from DEFINE must all be satisfied in BUILD results.
  const defineHandoff = handoffPath(ctx, 'define');
  const buildHandoff = handoffPath(ctx, 'build');
  const define = defineHandoff ? safeJson<DefineCriteria>(defineHandoff) : null;
  const buildRes = buildHandoff ? safeJson<BuildResults>(buildHandoff) : null;
  if (define?.criteria) {
    const passed = (buildRes?.results ?? [])
      .filter((r) => r.status === 'passed')
      .map((r) => r.criterion);
    const diff = criteriaDiff(define.criteria, passed);
    for (const id of diff.unmet) {
      reasons.push(`acceptance criterion not satisfied: ${id}`);
      unmet.push(id);
    }
    // Phantom criteria: the build certifies passing a criterion DEFINE never
    // declared — a build↔define SET drift the spine can catch DETERMINISTICALLY,
    // with no reliance on the worker disclosing it (raises the §7 ceiling: gates
    // no longer just match ids one-way, they enforce set-consistency both ways).
    for (const id of diff.extra) {
      reasons.push(`build certifies a criterion DEFINE never declared (phantom/drift): ${id}`);
      unmet.push(`phantom:${id}`);
    }
  }

  // Evidence-backed pass: a criterion that CITES a verifier (verified_by) which
  // looks like a file must point at one that exists — "passed" carries proof,
  // the same evidence-before-exit-0 rule G_AUDIT applies to built[] items.
  for (const r of buildRes?.results ?? []) {
    if (r.status === 'passed' && r.verified_by && looksLikePath(r.verified_by)) {
      if (!fs.existsSync(path.join(ctx.root, r.verified_by))) {
        reasons.push(`acceptance criterion ${r.criterion} cites a verifier that does not exist: ${r.verified_by}`);
        unmet.push(`evidence-missing:${r.criterion}`);
      }
    }
  }

  return unmet.length === 0 ? pass(gate, ['build verified']) : block(gate, reasons, unmet);
}

/** G_SHIP — inside /ship. define.criteria minus build.passed must be empty. */
export function gShip(ctx: GateContext): GateResult {
  const gate = 'G_SHIP';
  const defineHandoff = handoffPath(ctx, 'define');
  const buildHandoff = handoffPath(ctx, 'build');
  const define = defineHandoff ? safeJson<DefineCriteria>(defineHandoff) : null;
  const buildRes = buildHandoff ? safeJson<BuildResults>(buildHandoff) : null;

  if (!define?.criteria) {
    return block(gate, ['define criteria unavailable — cannot certify ship'], ['handoff:define']);
  }
  const passed = (buildRes?.results ?? [])
    .filter((r) => r.status === 'passed')
    .map((r) => r.criterion);
  const diff = criteriaDiff(define.criteria, passed);
  if (diff.unmet.length > 0) {
    return block(
      gate,
      diff.unmet.map((id) => `unmet acceptance criterion: ${id}`),
      diff.unmet
    );
  }
  // Set-consistency both ways: ship cannot certify a build that passes a criterion
  // DEFINE never declared (phantom/drift the spine catches without disclosure).
  if (diff.extra.length > 0) {
    return block(
      gate,
      diff.extra.map((id) => `build certifies a criterion DEFINE never declared (drift): ${id}`),
      diff.extra.map((id) => `phantom:${id}`)
    );
  }
  // Criteria are met — but surface any spec-drift the build flagged (F6). Shipping
  // is allowed (the correction is legitimate), yet the warning is recorded loudly
  // in the gate reasons + run-state so a false DEFINE can't ride along unnoticed.
  // Final sign-off: criteria are met, but ship requires un-fakeable human approval
  // (set only by `spin approve` at an interactive terminal — the seam applied to ship).
  if (!ctx.runState?.approval) {
    return block(
      gate,
      ['human approval required — run `spin approve` (an automated agent cannot grant it)'],
      ['approval']
    );
  }
  const reasons = [
    `all ${define.criteria.length} acceptance criteria met`,
    `approved by ${ctx.runState.approval.by}`,
  ];
  const drift = specDrift(buildRes?.results ?? []);
  if (!drift.clean) {
    reasons.push(
      `⚠ ${drift.drifted.length} acceptance criterion/criteria were CORRECTED during build — reconcile DEFINE.md: ${drift.drifted
        .map((d) => `${d.criterion} (${d.correction})`)
        .join('; ')} — run: spin spec-drift --build <build-report.json>`
    );
  }
  return pass(gate, reasons);
}

function safeJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}
