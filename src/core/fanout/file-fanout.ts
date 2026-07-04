import * as fs from 'node:fs';
import * as path from 'node:path';

// File-level fan-out completeness. The ledger-based `spin fanout-check` cannot see
// a dropped PER-FILE build worker: in the SDD workflow the whole build phase is ONE
// ledger artifact (`build`), so its `parallel_group` has a single member and is
// trivially all-or-nothing. The real fan-out unit is one worker per design-manifest
// file, each leaving a `build-task` sidecar whose required `file` field names the
// exact manifest path it built. Comparing manifest[] against those sidecars is the
// deterministic proof that no worker silently vanished. This is accounting + a
// verdict — the CLI names the missing units; it NEVER dispatches.

/** One row of the design handoff's manifest[] (DesignHandoff in ../handoff/schemas.ts). */
export interface ManifestEntry {
  file: string;
  action: 'create' | 'modify' | 'delete';
  purpose: string;
}

/** A build-task sidecar found on disk: where it lives + the manifest path it claims. */
export interface SidecarRef {
  sidecar: string; // sidecar filename (relative to the handoffs dir)
  file: string; // the build-task `file` field — the join key to manifest[].file
}

export interface FileFanoutVerdict {
  passed: boolean;
  expected: number;
  found: number;
  matched: Array<{ file: string; sidecar: string }>;
  /** The re-dispatch list: manifest entries with NO matching build-task sidecar. */
  missing: ManifestEntry[];
  /** build-task sidecars naming files the manifest never listed (informational). */
  extra: SidecarRef[];
  reasons: string[];
  unmet: string[]; // fanout-missing:<file>
}

/**
 * Pure comparison: every manifest file must have a build-task sidecar whose `file`
 * field matches it exactly. Missing entries are returned verbatim so the
 * orchestrating command can re-dispatch ONLY the dropped units.
 */
export function compareManifestToSidecars(
  manifest: ManifestEntry[],
  sidecars: SidecarRef[]
): FileFanoutVerdict {
  const byFile = new Map<string, string>();
  for (const s of sidecars) {
    // First sidecar claiming a file wins; duplicates are harmless for presence.
    if (!byFile.has(s.file)) byFile.set(s.file, s.sidecar);
  }

  const manifestFiles = new Set(manifest.map((m) => m.file));
  const matched: Array<{ file: string; sidecar: string }> = [];
  const missing: ManifestEntry[] = [];
  for (const entry of manifest) {
    const sidecar = byFile.get(entry.file);
    if (sidecar !== undefined) matched.push({ file: entry.file, sidecar });
    else missing.push(entry);
  }
  const extra = sidecars.filter((s) => !manifestFiles.has(s.file));

  const reasons: string[] = [];
  const unmet: string[] = [];
  if (missing.length > 0) {
    reasons.push(
      `manifest fan-out is partially complete (${matched.length}/${manifest.length}) — no build-task sidecar for: ${missing
        .map((m) => m.file)
        .join(', ')}`
    );
    for (const m of missing) unmet.push(`fanout-missing:${m.file}`);
  }

  return {
    passed: missing.length === 0,
    expected: manifest.length,
    found: matched.length,
    matched,
    missing,
    extra,
    reasons,
    unmet,
  };
}

/**
 * Scan a handoffs dir (non-recursive) for build-task sidecars: any *.json that
 * parses and carries a string `file` field. Sidecar NAMES are orchestrator-chosen,
 * so identity comes from the `file` field (required by the build-task schema to be
 * the exact manifest path), not the filename. Other sidecars in the same dir
 * (define/design/build-report/finding) have no top-level `file` and are skipped,
 * as is unparseable JSON — a worker that emitted garbage has not accounted for its
 * unit and correctly shows up as missing.
 */
export function readBuildTaskSidecarRefs(dir: string): SidecarRef[] {
  const refs: SidecarRef[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
    } catch {
      continue; // not a valid sidecar — cannot account for any unit
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { file?: unknown }).file === 'string'
    ) {
      refs.push({ sidecar: name, file: (parsed as { file: string }).file });
    }
  }
  return refs;
}
