import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// `spin verify-self` — a dist-integrity witness. Recomputes sha256 over the files
// `build.js` recorded in verification/checksums.json (dist/cli/index.js,
// plugin/dist/cli/index.js, and every schemas/**+plugin/schemas/** file) and
// compares. Node builtins ONLY (fs/path/crypto) — no runtime dependency, so the
// check can never itself be the thing that's broken.

export interface ChecksumManifest {
  note?: string;
  generatedAt?: string;
  files: Record<string, string>;
}

export interface VerifySelfResult {
  passed: boolean;
  manifest: string;
  checked: number;
  matched: string[];
  mismatched: string[];
  missing: string[];
}

export function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function loadChecksumManifest(manifestPath: string): ChecksumManifest {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
  const obj = raw as { files?: unknown };
  if (!raw || typeof raw !== 'object' || typeof obj.files !== 'object' || obj.files === null) {
    throw new Error(`${manifestPath} does not have the expected {files: {<relpath>: <sha256>}} shape`);
  }
  return raw as ChecksumManifest;
}

/** Recompute sha256 for every file the manifest lists (paths resolved against
 *  `root`) and compare against the recorded digest. A file absent on disk is
 *  `missing`, not silently skipped — a missing dist file is exactly the kind of
 *  drift this exists to catch. */
export function verifySelf(root: string, manifestPath: string): VerifySelfResult {
  const manifest = loadChecksumManifest(manifestPath);
  const matched: string[] = [];
  const mismatched: string[] = [];
  const missing: string[] = [];

  for (const [rel, expected] of Object.entries(manifest.files)) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (!fs.existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    const actual = sha256File(abs);
    if (actual === expected) matched.push(rel);
    else mismatched.push(rel);
  }

  return {
    passed: mismatched.length === 0 && missing.length === 0,
    manifest: manifestPath,
    checked: Object.keys(manifest.files).length,
    matched: matched.sort(),
    mismatched: mismatched.sort(),
    missing: missing.sort(),
  };
}
