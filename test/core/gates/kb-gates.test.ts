import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gKbStructure, gKbCoverage } from '../../../src/core/gates/kb-gates.js';
import type { GateContext } from '../../../src/core/gates/types.js';

// Unit coverage for the KB overhaul: manifest-shape enforcement (Zod) + E-1
// needs_decoding/decoding_note enforcement. Both are pure reads over a fixture dir.

let root: string;
let featureDir: string;
let handoffDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-kbgate-'));
  featureDir = path.join(root, 'domain');
  handoffDir = path.join(featureDir, '.handoffs');
  fs.mkdirSync(handoffDir, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function ctx(): GateContext {
  return { root, args: {}, runState: null, graph: null, featureDir, handoffDir };
}
function manifest(obj: unknown): void {
  fs.writeFileSync(path.join(featureDir, 'manifest.json'), JSON.stringify(obj));
}
function concept(slug: string): void {
  fs.writeFileSync(path.join(featureDir, `concept-${slug}.md`), `# ${slug}\n`);
}
function handoff(slug: string, obj: unknown): void {
  fs.writeFileSync(path.join(handoffDir, `kb-concept-${slug}.json`), JSON.stringify(obj));
}

describe('G_KB_COVERAGE — manifest shape + E-1 honesty', () => {
  it('passes a well-formed domain', () => {
    manifest({ concepts: [{ slug: 'hard-seam' }] });
    concept('hard-seam');
    handoff('hard-seam', { concept: 'hard-seam', summary: 's', test_cases: ['t'] });
    expect(gKbCoverage(ctx()).passed).toBe(true);
  });

  it('blocks on a malformed manifest (wrong key)', () => {
    manifest({ concepts: [{ name: 'x' }] });
    const r = gKbCoverage(ctx());
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('manifest-shape');
  });

  it('rejects a slug with a slash or dot (no subdir smuggling)', () => {
    manifest({ concepts: [{ slug: 'foo/bar' }] });
    expect(gKbCoverage(ctx()).unmet).toContain('manifest-shape');
    manifest({ concepts: [{ slug: 'foo.bar' }] });
    expect(gKbCoverage(ctx()).unmet).toContain('manifest-shape');
  });

  it('blocks E-1 when needs_decoding=true and decoding_note is empty', () => {
    manifest({ concepts: [{ slug: 'opaque' }] });
    concept('opaque');
    handoff('opaque', { concept: 'opaque', summary: 's', test_cases: ['t'], needs_decoding: true });
    const r = gKbCoverage(ctx());
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('e1-decoding-note:opaque');
  });

  it('passes E-1 when needs_decoding=true carries a non-empty decoding_note', () => {
    manifest({ concepts: [{ slug: 'opaque' }] });
    concept('opaque');
    handoff('opaque', {
      concept: 'opaque',
      summary: 's',
      test_cases: ['t'],
      needs_decoding: true,
      decoding_note: 'status code 7 is opaque in source',
    });
    expect(gKbCoverage(ctx()).passed).toBe(true);
  });
});

describe('G_KB_STRUCTURE — manifest shape', () => {
  it('blocks on a malformed manifest when present', () => {
    fs.writeFileSync(path.join(featureDir, 'index.md'), '# i\n');
    fs.writeFileSync(path.join(featureDir, 'quick-reference.md'), '# q\n');
    concept('foo');
    manifest({ concepts: [] }); // empty -> fails min(1)
    const r = gKbStructure(ctx());
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('manifest-shape');
  });
});
