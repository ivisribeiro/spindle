import * as fs from 'node:fs';
import * as path from 'node:path';
import { type GateContext, type GateResult, pass, block } from './types.js';
import {
  validateSections,
  hasManifestTable,
  parseSections,
  findPlaceholders,
} from '../validation/md-section-validator.js';
import { computeDefineCoverage, type CoverageResult } from '../validation/define-coverage.js';
import { criteriaDiff } from '../validation/criteria-diff.js';
import { checkHandoffFile } from '../handoff/handoff-check.js';
import { specDrift } from '../spec-drift.js';
import { isContainedPath } from '../util/paths.js';

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

const CRITERIA_SECTION = 'Acceptance Criteria';
const REQUIRED_DEFINE_SECTIONS = ['Why', 'What', CRITERIA_SECTION];
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

  // Stub criteria block UNCONDITIONALLY. `validateSections` already proves the
  // section has a body; it cannot tell `AC-1: the CRC is 29B1` from `AC-1: TBD`.
  // Inside the criteria section a stub token is unambiguously not a criterion, so
  // this needs no config knob — an unwritten criterion can't be diffed at G_BUILD.
  const criteriaBody = parseSections(md).find(
    (sec) => sec.title.trim().toLowerCase() === CRITERIA_SECTION.toLowerCase()
  )?.body;
  if (criteriaBody) {
    for (const token of findPlaceholders(criteriaBody)) {
      reasons.push(`"${CRITERIA_SECTION}" still carries the placeholder "${token}"`);
      unmet.push(`placeholder-criterion:${token}`);
    }
  }

  let coverage: CoverageResult | null = null;
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
      const data = check.data as {
        clarity?: number;
        criteria?: string[];
        open_questions?: string[];
      };
      if (typeof floor === 'number' && typeof data.clarity === 'number' && data.clarity < floor) {
        reasons.push(`clarity ${data.clarity} is below the configured floor ${floor}`);
        unmet.push('clarity-floor');
      }

      // The deterministic counterweight to that self-reported clarity: a readiness
      // score the SPINE derives from DEFINE.md + this handoff. Also UNSET by default.
      coverage = computeDefineCoverage({
        markdown: md,
        criteria: data.criteria ?? [],
        openQuestions: data.open_questions ?? [],
      });
      const coverageFloor = ctx.graph?.getSchema().config?.coverage_floor;
      if (typeof coverageFloor === 'number' && coverage.readiness < coverageFloor) {
        reasons.push(
          `discovery readiness ${coverage.readiness} is below the configured floor ${coverageFloor} ` +
            `(coverage ${coverage.coverage}, decision clarity ${coverage.decision_clarity})`
        );
        unmet.push('coverage-floor');
        for (const blockId of coverage.uncovered) unmet.push(`coverage-block:${blockId}`);
      }
    }
  }

  if (unmet.length > 0) return block(gate, reasons, unmet);
  const summary = coverage
    ? `define complete (readiness ${coverage.readiness}, coverage ${coverage.coverage}, ` +
      `decision clarity ${coverage.decision_clarity})`
    : 'define complete';
  return pass(gate, [summary]);
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
    verified_by_result?: 'passed' | 'failed';
  }>;
  // Optional CI-produced coverage summary (BuildReportHandoff.coverage). When present and
  // below its own threshold, G_BUILD blocks — the schema field is no longer inert.
  coverage?: { tool?: string; pct?: number; threshold?: number };
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
      // Containment first: a manifest path must stay inside the project root — a `..`
      // escape can't be allowed to satisfy (or probe) a file outside the tree.
      if (!isContainedPath(ctx.root, entry.file)) {
        reasons.push(`manifest file escapes the project root: ${entry.file}`);
        unmet.push(`unsafe-path:${entry.file}`);
        continue;
      }
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
      if (!isContainedPath(ctx.root, r.verified_by)) {
        reasons.push(`acceptance criterion ${r.criterion} cites a verifier outside the project root: ${r.verified_by}`);
        unmet.push(`unsafe-path:${r.criterion}`);
      } else if (!fs.existsSync(path.join(ctx.root, r.verified_by))) {
        reasons.push(`acceptance criterion ${r.criterion} cites a verifier that does not exist: ${r.verified_by}`);
        unmet.push(`evidence-missing:${r.criterion}`);
      }
    }
  }

  // Tests at build. The spine READS the CI-produced verifier result; it never runs a
  // verifier (execution lives in CI, the result flows in as data). Two checks:
  const requireVerifier = ctx.graph?.getSchema().config?.require_verified_by === true;
  for (const r of buildRes?.results ?? []) {
    if (r.status !== 'passed') continue;
    // (a) a passed criterion may not claim a verifier CI reported as failed.
    if (r.verified_by_result === 'failed') {
      reasons.push(`acceptance criterion ${r.criterion} is marked passed but its verifier reported failed`);
      unmet.push(`verifier-failed:${r.criterion}`);
    }
    // (b) when the schema requires it, every passed criterion must cite a verifier (a test).
    if (requireVerifier && !r.verified_by) {
      reasons.push(`acceptance criterion ${r.criterion} is passed but cites no verifier (config.require_verified_by)`);
      unmet.push(`missing-verifier:${r.criterion}`);
    }
  }

  // Coverage floor — when the CI-populated coverage summary is present and below its own
  // threshold, block. Additive: a build-report without `coverage` is unaffected (the field
  // is optional and stops being a dead schema promise only when actually reported).
  const cov = buildRes?.coverage;
  if (cov && typeof cov.pct === 'number' && typeof cov.threshold === 'number' && cov.pct < cov.threshold) {
    reasons.push(`test coverage ${cov.pct}% is below the required threshold ${cov.threshold}%${cov.tool ? ` (${cov.tool})` : ''}`);
    unmet.push('coverage-below-threshold');
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
  // Final sign-off: criteria are met, but ship requires un-fakeable human approval
  // (set only by `spin approve` at an interactive terminal — the seam applied to ship).
  if (!ctx.runState?.approval) {
    return block(
      gate,
      ['human approval required — run `spin approve` (an automated agent cannot grant it)'],
      ['approval']
    );
  }
  // Unreconciled spec-drift BLOCKS ship (P0). When the build flagged a criterion whose
  // DEFINE-stated value was wrong and implemented the CORRECT one, the shipped spec is
  // still false until DEFINE is reconciled (`reconciled: true` on that build result).
  // A green G_SHIP must never be recorded for a run whose own DEFINE its build
  // contradicts. Reconciled corrections and no-drift pass through unchanged.
  const drift = specDrift(buildRes?.results ?? []);
  if (!drift.clean) {
    return block(
      gate,
      [
        `${drift.drifted.length} acceptance criterion/criteria were CORRECTED during build but DEFINE.md is not reconciled — the shipped spec is still false: ${drift.drifted
          .map((d) => `${d.criterion} (${d.correction})`)
          .join('; ')}`,
        'update DEFINE.md then set `reconciled: true` on each corrected build result — run `spin spec-drift --build <build-report.json>` for the detailed diff',
      ],
      drift.drifted.map((d) => `spec-drift:${d.criterion}`)
    );
  }
  return pass(gate, [
    `all ${define.criteria.length} acceptance criteria met`,
    `approved by ${ctx.runState.approval.by}`,
  ]);
}

function safeJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}
