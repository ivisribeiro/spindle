#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repo = fileURLToPath(new URL('../', import.meta.url));
const workflow = '.spindle/harness-workflow.md';
const runtime = '.spindle/harness/bin/spin.js';
const feature = 'payment-reconciliation';
const artifacts = `.spindle/features/${feature}`;
const define = `${artifacts}/DEFINE.md`;
const defineHandoff = `${artifacts}/.handoffs/define.json`;
const design = `${artifacts}/DESIGN.md`;
const designHandoff = `${artifacts}/.handoffs/design.json`;
const definePrompt = 'Read the installed .spindle/harness-workflow.md and follow the Spindle Define phase only for the active payment-reconciliation run. A payment import is keyed by payment ID. Record AC-1: importing a new payment credits its amount once. Record AC-2: replaying the same payment ID leaves the balance unchanged. This is a local JavaScript module, no service or network. Use the installed project CLI to record Define and its gate. Stop after Define.';
const resumePrompt = 'Run Spindle resume for payment-reconciliation. Read the installed .spindle/harness-workflow.md and resume one phase from the current checkout. You have no prior chat context.';

const remediation = {
  designRecorded: 'Finish the selected phase as a ledger transition. For Design, write both DESIGN.md and its design JSON handoff, run the phase validation, record completion through spin complete, and run its gate. A Markdown draft alone leaves the run pending.',
  definePreserved: 'Treat completed predecessor files and their canonical handoffs as read-only while resuming. If a change to a completed predecessor is required, stop and request an explicit Iterate action.',
  phaseAfterDesign: 'Stop immediately after recording the requested phase and its gate. Report the next ready phase without authoring or completing it.',
  designGate: 'Run and inspect the selected phase gate after completion. A valid artifact and recorded completion still require that gate’s exit 0 before reporting success.',
};

const digest = (content) => createHash('sha256').update(content).digest('hex');
const hashFile = (cwd, path) => {
  try {
    const file = join(cwd, path);
    return lstatSync(file).isFile() ? digest(readFileSync(file)) : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
function readJson(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return {};
  }
}
function invoke(cwd, executable, args) {
  return spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 30_000 });
}
function spin(cwd, ...args) {
  return invoke(cwd, process.execPath, [join(repo, 'bin/spin.js'), ...args]);
}
function requireSuccess(result, description) {
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || result.error?.message;
    throw new Error(`${description} failed${detail ? `: ${detail}` : ''}`);
  }
}
function writeJson(cwd, path, value) {
  writeFileSync(join(cwd, path), JSON.stringify(value, null, 2) + '\n');
}
function seed(cwd) {
  mkdirSync(cwd);
  requireSuccess(invoke(cwd, 'git', ['init', '-q']), 'git init');
  writeFileSync(join(cwd, 'README.md'), '# Payment reconciliation\n\nA small local JavaScript payment importer.\n');
  requireSuccess(invoke(cwd, process.execPath, [join(repo, 'bin/spindle-install.js'), '--target', 'all']), 'spindle-install');
  requireSuccess(spin(cwd, 'init', '--schema', 'sdd', '--feature', feature), 'spin init');
}
function simulateDefine(cwd) {
  writeFileSync(join(cwd, define), '# Definition\n\n## Why\nImport retries can duplicate credits.\n\n## What\nCredit each unique payment ID once.\n\n## Acceptance Criteria\n- AC-1: Importing a new payment credits its amount once.\n- AC-2: Replaying a payment ID leaves the balance unchanged.\n');
  writeJson(cwd, defineHandoff, { feature, clarity: 0.9, criteria: ['AC-1', 'AC-2'] });
  requireSuccess(spin(cwd, 'complete', 'define', '--handoff', defineHandoff), 'fixture complete define');
  requireSuccess(spin(cwd, 'gate', 'G_DEFINE'), 'fixture G_DEFINE');
}
function simulateResume(cwd) {
  writeFileSync(join(cwd, design), '# Design\n\n## Overview\nTrack posted IDs and add amounts for new IDs only.\n\n## File Manifest\n\n| File | Action | Purpose |\n| --- | --- | --- |\n| payments.js | create | Handle first imports and duplicate IDs |\n\n## Decisions\nCheck the payment ID before changing the balance.\n');
  // Seed a deliberate regression. This fixture exercises the loop plumbing;
  // it is not a model responding differently to two prompts.
  if (!readFileSync(join(cwd, workflow), 'utf8').includes(remediation.designRecorded)) return;
  writeJson(cwd, designHandoff, {
    feature,
    manifest: [{ file: 'payments.js', action: 'create', purpose: 'Post each payment ID once' }],
    decisions: ['Check the payment ID before changing the balance.'],
  });
  requireSuccess(spin(cwd, 'complete', 'design', '--handoff', designHandoff), 'fixture complete design');
  requireSuccess(spin(cwd, 'gate', 'G_DESIGN'), 'fixture G_DESIGN');
}
function gradeDefine(cwd) {
  const state = readJson(spin(cwd, 'state'));
  const handoff = readJson(spin(cwd, 'handoff-check', 'define', defineHandoff));
  const ready = readJson(spin(cwd, 'next')).ready ?? [];
  return state.feature === feature &&
    (state.completed ?? []).join() === 'define' &&
    state.approval === null &&
    state.gates?.G_DEFINE?.passed === true &&
    handoff.ok === true &&
    ['AC-1', 'AC-2'].every(id => handoff.data?.criteria?.includes(id)) &&
    ready.some(artifact => artifact.id === 'design');
}
// Recompute the gate on a disposable copy. The native client's recorded
// verdict still has to be green, and grading never modifies its trial.
function recomputeDesignGate(cwd) {
  const scratch = mkdtempSync(join(tmpdir(), 'spindle-prompt-grade-'));
  try {
    cpSync(join(cwd, '.spindle'), join(scratch, '.spindle'), { recursive: true });
    return spin(scratch, 'gate', 'G_DESIGN').status === 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
function gradeResume(cwd, snapshot, exitCode) {
  const state = readJson(spin(cwd, 'state'));
  const completed = state.completed ?? [];
  const ready = readJson(spin(cwd, 'next')).ready ?? [];
  const definePreserved = completed.includes('define') && state.gates?.G_DEFINE?.passed === true &&
    [define, defineHandoff, '.spindle/schema.yaml'].every(path => {
      const actual = hashFile(cwd, path);
      return actual !== null && actual === hashFile(snapshot, path);
    });
  const expectedRoot = readdirSync(snapshot).sort().join();
  return {
    clientExited: exitCode === 0,
    featurePreserved: state.feature === feature,
    definePreserved,
    designRecorded: completed.includes('design'),
    designValid: spin(cwd, 'validate', 'design').status === 0 &&
      spin(cwd, 'handoff-check', 'design', designHandoff).status === 0,
    designGate: state.gates?.G_DESIGN?.passed === true &&
      ready.some(artifact => artifact.id === 'build') && recomputeDesignGate(cwd),
    phaseAfterDesign: completed.every(id => id === 'define' || id === 'design') && state.approval === null,
    workspacePreserved: readdirSync(cwd).sort().join() === expectedRoot &&
      hashFile(cwd, 'README.md') === hashFile(snapshot, 'README.md'),
    traceValid: spin(cwd, 'trace', '--verify').status === 0,
  };
}

function propose(baseline, assessments) {
  const rule = Object.keys(remediation).find(key => assessments.some(result =>
    result.exitCode === 0 && result.checks.featurePreserved && result.checks[key] === false));
  if (!rule) return null;
  const anchor = '## Phase protocol';
  if (!baseline.includes(anchor)) throw new Error('Missing phase protocol anchor in baseline prompt');
  const amendment = remediation[rule];
  if (baseline.includes(amendment)) return null;
  return { rule, prompt: baseline.replace(anchor, `### Resume checkpoint\n\n${amendment}\n\n${anchor}`) };
}
const passed = checks => Object.values(checks).every(Boolean);

async function main() {
  const { values } = parseArgs({ options: {
    mode: { type: 'string', default: 'fixture' },
    out: { type: 'string' },
    trials: { type: 'string', default: '1' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/prompt-eval.mjs --mode fixture|live --out NEW_DIRECTORY [--trials 1..3]');
    return;
  }
  const trials = Number(values.trials);
  if (!values.out || !['fixture', 'live'].includes(values.mode) || !Number.isInteger(trials) || trials < 1 || trials > 3) {
    throw new Error('Expected --mode fixture|live --out NEW_DIRECTORY [--trials 1..3]');
  }
  const out = resolve(values.out);
  if (existsSync(out)) throw new Error('--out must name a new directory');
  const clients = values.mode === 'live' ? await import('./prompt-eval-clients.mjs') : null;
  const clientMetadata = clients ? await clients.checkClients() : null;
  if (!existsSync(dirname(out))) throw new Error('Create the parent of --out first');
  mkdirSync(out);
  const temp = mkdtempSync(join(tmpdir(), 'spindle-prompt-eval-'));
  const baseline = readFileSync(join(repo, 'plugin/adapters/workflow.md'), 'utf8');
  const report = {
    mode: values.mode,
    scenario: 'codex-define-claude-resume-design',
    synthetic: !clients,
    clientMetadata,
    baselineDigest: digest(baseline),
    producer: [],
    baseline: [],
    candidate: [],
    proposal: null,
    comparison: 'not-run',
    promoted: false,
  };
  const caseDirs = [];

  async function resume(snapshot, cwd, prompt) {
    cpSync(snapshot, cwd, { recursive: true });
    writeFileSync(join(cwd, workflow), prompt);
    const result = clients
      ? await clients.runClient('claude', { cwd, prompt: resumePrompt, timeoutMs: 180_000 })
      : (simulateResume(cwd), { exitCode: 0 });
    return {
      exitCode: result.exitCode,
      checks: gradeResume(cwd, snapshot, result.exitCode),
      ...(result.exitCode !== 0 ? { diagnostic: result.output } : {}),
    };
  }

  try {
    for (let trial = 1; trial <= trials; trial += 1) {
      const snapshot = join(temp, `define-${trial}`);
      seed(snapshot);
      const result = clients
        ? await clients.runClient('codex', { cwd: snapshot, prompt: definePrompt, timeoutMs: 180_000 })
        : (simulateDefine(snapshot), { exitCode: 0 });
      const reachedDefine = result.exitCode === 0 && gradeDefine(snapshot);
      report.producer.push({
        exitCode: result.exitCode, reachedDefine,
        ...(result.exitCode !== 0 ? { diagnostic: result.output } : {}),
      });
      if (result.exitCode !== 0) report.comparison = 'producer-client-blocked';
      if (!reachedDefine) throw new Error('Producer failed to establish the Define checkpoint; a resume comparison would be invalid.');
      caseDirs.push(snapshot);
      report.baseline.push(await resume(snapshot, join(temp, `baseline-${trial}`), baseline));
    }

    if (report.baseline.some(result => result.exitCode !== 0)) {
      report.comparison = 'resume-client-blocked';
      throw new Error('Claude could not complete the baseline. See the report for client diagnostics.');
    }
    const proposal = propose(baseline, report.baseline);
    if (proposal) {
      report.proposal = { remediation: proposal.rule, digest: digest(proposal.prompt), file: 'candidate-workflow.md' };
      writeFileSync(join(out, report.proposal.file), proposal.prompt);
      for (const [index, snapshot] of caseDirs.entries()) {
        report.candidate.push(await resume(snapshot, join(temp, `candidate-${index + 1}`), proposal.prompt));
      }
      const repaired = report.candidate.every(result => passed(result.checks)) &&
        report.baseline.some(result => !passed(result.checks));
      report.comparison = repaired
        ? clients ? 'candidate-ready-for-human-review' : 'simulated-repair-verified'
        : 'repair-not-verified';
    } else {
      report.comparison = report.baseline.every(result => passed(result.checks))
        ? 'baseline-passed-no-candidate'
        : 'no-eligible-remediation';
    }
    if (!clients && report.comparison !== 'simulated-repair-verified') {
      throw new Error('Fixture did not exercise the expected baseline failure and candidate repair.');
    }
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    writeJson(out, 'report.json', report);
    rmSync(temp, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ report: join(out, 'report.json'), comparison: report.comparison }));
}

main().catch(error => {
  console.error(`prompt-eval: ${error.message}`);
  process.exitCode = 1;
});
