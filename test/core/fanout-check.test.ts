import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fanoutCheckHandler } from '../../src/commands/handlers.js';
import { cli } from '../helpers.js';

// spin fanout-check: a started-but-unfinished parallel_group at a phase boundary is a
// dropped fan-out worker — the silent failure parallel-fanout itself cannot catch.

const SCHEMA = `name: t
version: 1
artifacts:
  - id: a
    generates: A.md
    parallel_group: wave
    requires: []
  - id: b
    generates: B.md
    parallel_group: wave
    requires: []
  - id: c
    generates: C.md
    requires: [a, b]
`;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-fanout-'));
  fs.mkdirSync(path.join(root, '.spindle'), { recursive: true });
  fs.writeFileSync(path.join(root, '.spindle', 'schema.yaml'), SCHEMA);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeRun(completed: string[]) {
  const now = '2026-01-01T00:00:00.000Z';
  fs.writeFileSync(
    path.join(root, '.spindle', 'run.json'),
    JSON.stringify({
      version: 1,
      schema: 't',
      feature: 'f',
      completed,
      retries: {},
      gates: {},
      events: [],
      createdAt: now,
      updatedAt: now,
    })
  );
}

describe('spin fanout-check', () => {
  it('blocks when a parallel_group is partially complete (dropped worker)', () => {
    writeRun(['a']); // a done, b dropped
    const r = fanoutCheckHandler(root);
    expect(r.code).toBe(1);
    expect((r.json as { unmet: string[] }).unmet).toContain('incomplete-group:wave:b');
  });

  it('passes when every member of the group is complete', () => {
    writeRun(['a', 'b']);
    expect(fanoutCheckHandler(root).code).toBe(0);
  });

  it('passes when the group has not started (no member complete)', () => {
    writeRun([]);
    expect(fanoutCheckHandler(root).code).toBe(0);
  });

  it('is a usage error before init', () => {
    fs.rmSync(path.join(root, '.spindle', 'run.json'), { force: true });
    expect(fanoutCheckHandler(root).code).toBe(2);
  });
});

// File-level mode (--manifest): in the SDD workflow the whole build phase is ONE
// ledger artifact, so ledger mode cannot see a dropped per-file build worker. The
// --manifest mode compares the design manifest against per-file build-task sidecars.

const DESIGN = {
  feature: 'f',
  manifest: [
    { file: 'src/a.ts', action: 'create', purpose: 'a' },
    { file: 'src/b.ts', action: 'create', purpose: 'b' },
    { file: 'src/c.ts', action: 'modify', purpose: 'c' },
  ],
  decisions: [],
  technologies: [],
};

function writeSidecar(dir: string, name: string, file: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, name),
    JSON.stringify({ file, verification_passed: true, retry_count: 0, criteria_satisfied: [], issues: [] })
  );
}

describe('spin fanout-check --manifest (file-level mode)', () => {
  let dir: string; // explicit --handoffs dir
  beforeEach(() => {
    dir = path.join(root, 'handoffs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, 'design.json'), JSON.stringify(DESIGN));
  });

  it('exits 1 with the dropped unit in missing[] when 2 of 3 sidecars exist', () => {
    writeSidecar(dir, 'task-a.json', 'src/a.ts');
    writeSidecar(dir, 'task-b.json', 'src/b.ts');
    const r = fanoutCheckHandler(root, { manifest: 'design.json', handoffs: 'handoffs' });
    expect(r.code).toBe(1);
    const j = r.json as { missing: Array<{ file: string; action: string; purpose: string }>; unmet: string[] };
    // missing[] carries the FULL manifest entry — the re-dispatch list
    expect(j.missing).toEqual([{ file: 'src/c.ts', action: 'modify', purpose: 'c' }]);
    expect(j.unmet).toEqual(['fanout-missing:src/c.ts']);
  });

  it('exits 0 when every manifest file has a build-task sidecar (3/3)', () => {
    writeSidecar(dir, 'task-a.json', 'src/a.ts');
    writeSidecar(dir, 'task-b.json', 'src/b.ts');
    writeSidecar(dir, 'task-c.json', 'src/c.ts');
    const r = fanoutCheckHandler(root, { manifest: 'design.json', handoffs: 'handoffs' });
    expect(r.code).toBe(0);
    expect((r.json as { passed: boolean }).passed).toBe(true);
  });

  it('ignores non-build-task sidecars living in the same dir', () => {
    writeSidecar(dir, 'task-a.json', 'src/a.ts');
    writeSidecar(dir, 'task-b.json', 'src/b.ts');
    writeSidecar(dir, 'task-c.json', 'src/c.ts');
    fs.writeFileSync(path.join(dir, 'design.json'), JSON.stringify(DESIGN)); // no `file` field
    fs.writeFileSync(path.join(dir, 'define.json'), JSON.stringify({ feature: 'f', clarity: 1, criteria: ['AC-1'] }));
    expect(fanoutCheckHandler(root, { manifest: 'design.json', handoffs: 'handoffs' }).code).toBe(0);
  });

  it('is a usage error (2) for a nonexistent manifest path', () => {
    const r = fanoutCheckHandler(root, { manifest: 'nope.json', handoffs: 'handoffs' });
    expect(r.code).toBe(2);
  });

  it('is a usage error (2) for a manifest that is not valid JSON', () => {
    fs.writeFileSync(path.join(root, 'bad.json'), '{ not json');
    expect(fanoutCheckHandler(root, { manifest: 'bad.json', handoffs: 'handoffs' }).code).toBe(2);
  });

  it('is a usage error (2) for a manifest that fails the design handoff schema', () => {
    fs.writeFileSync(path.join(root, 'notdesign.json'), JSON.stringify({ feature: 'f', manifest: [] }));
    expect(fanoutCheckHandler(root, { manifest: 'notdesign.json', handoffs: 'handoffs' }).code).toBe(2);
  });

  it('is a usage error (2) for a nonexistent --handoffs dir', () => {
    expect(fanoutCheckHandler(root, { manifest: 'design.json', handoffs: 'missing-dir' }).code).toBe(2);
  });

  it('is a usage error (2) when --handoffs is passed without --manifest', () => {
    expect(fanoutCheckHandler(root, { handoffs: 'handoffs' }).code).toBe(2);
  });

  it('defaults --handoffs to the active feature .handoffs/ when a run exists', () => {
    writeRun([]); // run.json declares feature "f"
    const featureHandoffs = path.join(root, '.spindle', 'features', 'f', '.handoffs');
    writeSidecar(featureHandoffs, 'task-a.json', 'src/a.ts');
    writeSidecar(featureHandoffs, 'task-b.json', 'src/b.ts');
    const r = fanoutCheckHandler(root, { manifest: 'design.json' });
    expect(r.code).toBe(1);
    expect((r.json as { unmet: string[] }).unmet).toEqual(['fanout-missing:src/c.ts']);
  });

  it('is a usage error (2) with --manifest but no --handoffs and no run to infer from', () => {
    fs.rmSync(path.join(root, '.spindle', 'run.json'), { force: true });
    expect(fanoutCheckHandler(root, { manifest: 'design.json' }).code).toBe(2);
  });

  it('parses the flags end-to-end through the CLI (exit 1 + missing[] on 2/3)', async () => {
    writeSidecar(dir, 'task-a.json', 'src/a.ts');
    writeSidecar(dir, 'task-b.json', 'src/b.ts');
    const r = await cli([
      '--root', root,
      'fanout-check',
      '--manifest', path.join(root, 'design.json'),
      '--handoffs', dir,
    ]);
    expect(r.code).toBe(1);
    expect(r.json.missing.map((x: { file: string }) => x.file)).toEqual(['src/c.ts']);
  });

  it('legacy ledger mode through the CLI is unchanged by the new flags', async () => {
    writeRun(['a']); // partial "wave" group in the ledger
    const r = await cli(['--root', root, 'fanout-check']);
    expect(r.code).toBe(1);
    expect(r.json.unmet).toContain('incomplete-group:wave:b');
  });
});
