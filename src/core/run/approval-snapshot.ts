import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GateContext } from '../gates/types.js';
import { BuildReportHandoff, DesignHandoff } from '../handoff/schemas.js';
import { isContainedPath } from '../util/paths.js';
import { looksLikePath } from '../validation/verifier-path.js';
import type { ApprovalSnapshot } from './run-state.schema.js';
import { schemaCopyPath } from './run-state.js';

type ApprovalContext = Pick<GateContext, 'root' | 'graph' | 'featureDir' | 'handoffDir'>;
type SnapshotResult = { ok: true; snapshot: ApprovalSnapshot } | { ok: false; reasons: string[] };
const APPROVED_PHASES = ['define', 'design', 'build'];

function readEvidence(root: string, candidate: string): Buffer {
  // Resolve through the real project root and reject linked, external and non-regular files.
  if (!isContainedPath(root, candidate) || fs.realpathSync(candidate) !== candidate) {
    throw new Error('path is outside the project or uses a symbolic link');
  }
  const fd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('not a regular file');
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** The scope is explicit: canonical artifacts and file evidence declared by Design and Build. */
export function captureApprovalSnapshot(ctx: ApprovalContext): SnapshotResult {
  const { graph, featureDir, handoffDir } = ctx;
  if (!graph || !featureDir || !handoffDir) {
    return { ok: false, reasons: ['active schema and feature are required to capture approval evidence'] };
  }
  const realRoot = fs.realpathSync(ctx.root);
  const files = new Map<string, string>();
  const read = (file: string): Buffer => {
    const rel = path.relative(path.resolve(ctx.root), path.resolve(ctx.root, file));
    const candidate = path.resolve(realRoot, rel);
    const portable = rel.split(path.sep).join('/');
    try {
      const content = readEvidence(realRoot, candidate);
      files.set(portable, createHash('sha256').update(content).digest('hex'));
      return content;
    } catch {
      throw new Error(`approval evidence is missing, unreadable, linked, or outside the project: ${portable}`);
    }
  };

  try {
    read(path.resolve(schemaCopyPath(ctx.root)));
    for (const phase of APPROVED_PHASES) {
      const artifact = graph.getArtifact(phase);
      if (!artifact) throw new Error(`approval evidence requires the ${phase} artifact`);
      read(path.resolve(featureDir, artifact.generates));
    }
    read(path.resolve(handoffDir, 'define.json'));
    const design = DesignHandoff.safeParse(JSON.parse(read(path.resolve(handoffDir, 'design.json')).toString('utf8')));
    const build = BuildReportHandoff.safeParse(JSON.parse(read(path.resolve(handoffDir, 'build.json')).toString('utf8')));
    if (!design.success || !build.success) throw new Error('approval requires valid Design and Build JSON handoffs');

    const evidence = [
      ...design.data.manifest.map(({ file }) => file),
      ...build.data.files_written,
      ...build.data.results.flatMap(({ verified_by }) => verified_by && looksLikePath(verified_by) ? [verified_by] : []),
    ];
    for (const file of new Set(evidence)) read(file);

    return {
      ok: true,
      snapshot: { version: 1, files: [...files.keys()].sort().map((file) => ({ path: file, sha256: files.get(file)! })) },
    };
  } catch (error) {
    return { ok: false, reasons: [error instanceof Error ? error.message : String(error)] };
  }
}

export function changedApprovalPaths(previous: ApprovalSnapshot, current: ApprovalSnapshot): string[] {
  const oldFiles = new Map(previous.files.map(({ path, sha256 }) => [path, sha256]));
  const newFiles = new Map(current.files.map(({ path, sha256 }) => [path, sha256]));
  return [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()
    .filter((file) => oldFiles.get(file) !== newFiles.get(file));
}
