import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tmpProject } from '../helpers.js';

const helper = fileURLToPath(new URL('../../plugin/scripts/codex-review.sh', import.meta.url));

function runReview(fakeCodex: string, enabled = '1') {
  const root = tmpProject();
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'codex'), '#!/bin/bash\n' + fakeCodex, { mode: 0o755 });
    return spawnSync('bash', [helper, 'src/file with spaces.ts'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: [bin, process.env.PATH].join(delimiter),
        SPINDLE_CODEX_ENABLED: enabled,
        SPINDLE_CODEX_FLAGS: '',
        SPINDLE_CODEX_MODEL: 'review-model',
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('Codex review helper response', () => {
  it('keeps diagnostics separate and launches the reviewer in a read-only sandbox', () => {
    const result = runReview(`
      printf '%s\\n' "$@" >&2
      echo '[]'
    `);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('[]\n');
    expect(result.stderr).toContain('--sandbox\nread-only\n');
    expect(result.stderr).toContain('-m\nreview-model\n');
    expect(result.stderr).toContain('src/file with spaces.ts');
  });

  it('discards even valid-looking stdout from a failed reviewer', () => {
    const result = runReview("echo '[]'; echo 'connection lost' >&2; exit 1");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^CODEX_ERROR:/);
    expect(result.stdout).not.toContain('[]');
    expect(result.stderr).toContain('connection lost');
  });

  it('returns a skip when independent review is disabled', () => {
    const result = runReview("echo 'unexpected invocation'", '0');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^CODEX_DISABLED:/);
    expect(result.stdout).not.toContain('unexpected invocation');
  });
});
