import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  findPlaceholders,
  findDanglingReferences,
  findInvalidUrls,
} from '../../../src/core/validation/md-section-validator.js';

describe('findPlaceholders', () => {
  it('finds stub tokens regardless of case and dedupes them', () => {
    expect(findPlaceholders('- AC-1: TBD\n- AC-2: tbd\n- AC-3: FIXME')).toEqual(['fixme', 'tbd']);
  });

  it('matches the pt-BR and long-form stubs', () => {
    expect(findPlaceholders('a definir')).toEqual(['a definir']);
    expect(findPlaceholders('to be determined')).toEqual(['to be determined']);
  });

  it('returns nothing for real prose', () => {
    expect(findPlaceholders('- AC-1: the portal rejects an unauthenticated submission.')).toEqual([]);
  });

  it('does not fire on substrings of ordinary words', () => {
    // "tbd"/"todo" inside a larger token must not count.
    expect(findPlaceholders('the subtbd value and a todos list')).toEqual([]);
  });
});

describe('findDanglingReferences', () => {
  it('flags dependence on a document the artifact does not carry', () => {
    expect(findDanglingReferences('Implement as described above.')).toEqual(['as described above']);
    expect(findDanglingReferences('Veja o documento acima.')).toEqual(['documento acima']);
  });

  it('leaves self-contained prose alone', () => {
    expect(findDanglingReferences('The API returns 200 on success.')).toEqual([]);
  });
});

describe('findInvalidUrls', () => {
  it('flags a scheme with no host', () => {
    expect(findInvalidUrls('See https:// for details')).toEqual(['https://']);
  });

  it('flags a URL: line whose value is not a URL', () => {
    expect(findInvalidUrls('URL: internal-wiki-page')).toEqual(['internal-wiki-page']);
  });

  it('accepts a real URL and strips trailing punctuation', () => {
    expect(findInvalidUrls('See https://example.com/docs (page 3).')).toEqual([]);
  });

  it('never flags a relative markdown link — a path is not a citation', () => {
    expect(findInvalidUrls('See [the module](src/core/gates/sdd-gates.ts).')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The advisory payload on `spin validate` — asserted through the real handler so
// the "exit code is unaffected" contract is tested, not just assumed.
// ---------------------------------------------------------------------------
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initHandler, validateHandler } from '../../../src/commands/handlers.js';

describe('spin validate — advisory payload', () => {
  let root: string;
  let defineMd: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-validate-'));
    initHandler(root, { schema: 'sdd', feature: 'feat' });
    const featureDir = path.join(root, '.spindle', 'features', 'feat');
    fs.mkdirSync(path.join(featureDir, '.handoffs'), { recursive: true });
    defineMd = path.join(featureDir, 'DEFINE.md');
    fs.writeFileSync(
      defineMd,
      '## Why\nSecurity matters as described above.\n## What\ny\n## Acceptance Criteria\n- AC-1: real criterion.\n'
    );
    fs.writeFileSync(
      path.join(featureDir, '.handoffs', 'define.json'),
      JSON.stringify({ feature: 'feat', clarity: 0.9, criteria: ['AC-1'], open_questions: [] })
    );
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reports coverage + warnings without changing a passing exit code', () => {
    const r = validateHandler(root, 'define');
    expect(r.code).toBe(0);
    const json = r.json as Record<string, unknown>;
    expect(json.valid).toBe(true);
    expect(json.warnings).toContain('dangling cross-reference: "as described above"');
    expect(json.coverage).toMatchObject({ covered: expect.arrayContaining(['security']) });
  });

  it('reports coverage when validate is called by PATH, as /define does', () => {
    const byPath = validateHandler(root, defineMd);
    const byId = validateHandler(root, 'define');
    expect(byPath.code).toBe(0);
    expect((byPath.json as Record<string, unknown>).coverage).toEqual(
      (byId.json as Record<string, unknown>).coverage
    );
  });

  it('still reports the advisory payload on a BLOCKING verdict', () => {
    fs.writeFileSync(defineMd, '## Why\nsee the document above\n'); // missing sections
    const r = validateHandler(root, 'define');
    expect(r.code).toBe(1);
    const json = r.json as Record<string, unknown>;
    expect(json.valid).toBe(false);
    expect(json.warnings).toBeDefined();
    expect(json.coverage).toBeDefined();
  });

  it('omits both advisory fields entirely when there is nothing to say', () => {
    fs.writeFileSync(
      path.join(root, 'PLAIN.md'),
      '## Overview\nclean prose with no stubs and no cross-references.\n'
    );
    const r = validateHandler(root, path.join(root, 'PLAIN.md'));
    expect(r.code).toBe(0);
    expect(r.json).not.toHaveProperty('warnings');
    expect(r.json).not.toHaveProperty('coverage');
  });
});
