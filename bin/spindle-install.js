#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderAdapters } from '../plugin/adapters/render.js';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const targets = ['codex', 'claude', 'gemini', 'cursor', 'portable'];
const runtime = '.spindle/harness';
const manifestPath = `${runtime}/install-manifest.json`;
const lockPath = '.spindle/harness-install.lock';
const help = `Usage: spindle-install [--root <project>] [--target <name>]

  --root     Existing project directory (default: current directory)
  --target   codex, claude, gemini, cursor, portable, or all (default: all)
  --help     Show this message
`;

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function statIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// Walk from the real project root so existing symlinks cannot send writes
// into another checkout or the user's global configuration.
function projectFile(root, relativePath) {
  const parts = relativePath.split('/');
  let path = root;
  for (const [index, part] of parts.entries()) {
    if (!part || part === '.' || part === '..' || /[\\:]/.test(part)) {
      throw new Error(`Unsafe install path: ${relativePath}`);
    }
    path = join(path, part);
    const stat = statIfPresent(path);
    if (stat && !(index === parts.length - 1 ? stat.isFile() : stat.isDirectory())) {
      throw new Error(`Expected a regular file or directory without symlinks: ${path}`);
    }
  }
  return path;
}

function packagedFiles(directory) {
  const files = [];
  for (const entry of readdirSync(join(sourceRoot, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...packagedFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function desiredFiles(selectedTargets) {
  const files = new Map();
  for (const target of selectedTargets) {
    for (const { path, content } of await renderAdapters(target)) {
      const bytes = Buffer.from(content);
      const existing = files.get(path);
      if (existing && !existing.equals(bytes)) {
        throw new Error(`Adapters disagree on generated contents for ${path}`);
      }
      files.set(path, bytes);
    }
  }

  files.set(`${runtime}/package.json`, Buffer.from('{"private":true,"type":"module"}\n'));
  const assets = ['bin/spin.js', 'dist/cli/index.js', ...packagedFiles('schemas')];
  for (const path of assets) {
    files.set(`${runtime}/${path}`, readFileSync(join(sourceRoot, path)));
  }
  return files;
}

function readExisting(path) {
  return statIfPresent(path) ? readFileSync(path) : undefined;
}

function readManifest(content) {
  if (!content) return new Map();
  const manifest = JSON.parse(content.toString('utf8'));
  if (manifest?.version !== 1 || !manifest.files || typeof manifest.files !== 'object' ||
      Array.isArray(manifest.files) ||
      Object.values(manifest.files).some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error(`Unrecognized installation manifest: ${manifestPath}`);
  }
  return new Map(Object.entries(manifest.files));
}

function publish(path, content, previous) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const tempFd = openSync(temp, 'wx');
  try {
    try {
      writeFileSync(tempFd, content);
    } finally {
      closeSync(tempFd);
    }
    if (previous) {
      const current = readExisting(path);
      if (!current?.equals(previous)) throw new Error(`File changed during install: ${path}`);
      renameSync(temp, path);
    } else {
      // Hard-linking a staged file publishes complete bytes and refuses to
      // replace a file created by another process after preflight.
      linkSync(temp, path);
    }
  } finally {
    if (statIfPresent(temp)) unlinkSync(temp);
  }
}

function install(root, files) {
  const lock = projectFile(root, lockPath);
  mkdirSync(dirname(lock), { recursive: true });
  let lockFd;
  try {
    lockFd = openSync(lock, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another install is active. If no installer is running, remove ${lock} and retry.`);
  }

  try {
    const manifestFile = projectFile(root, manifestPath);
    const manifestBefore = readExisting(manifestFile);
    const manifest = readManifest(manifestBefore);
    const updates = [];
    const conflicts = [];
    for (const [path, content] of files) {
      const destination = projectFile(root, path);
      const previous = readExisting(destination);
      const hash = digest(content);
      if (previous && !previous.equals(content) && digest(previous) !== manifest.get(path)) {
        conflicts.push(path);
        continue;
      }
      if (!previous?.equals(content)) updates.push({ path, content, previous });
      manifest.set(path, hash);
    }
    if (conflicts.length) throw new Error(`Existing or locally edited files would be overwritten:\n  ${conflicts.join('\n  ')}`);

    for (const { path, content, previous } of updates) {
      publish(projectFile(root, path), content, previous);
    }
    const manifestAfter = Buffer.from(JSON.stringify({
      version: 1,
      files: Object.fromEntries([...manifest.keys()].sort().map((path) => [path, manifest.get(path)])),
    }, null, 2) + '\n');
    if (!manifestBefore?.equals(manifestAfter)) publish(manifestFile, manifestAfter, manifestBefore);
    return updates.length;
  } finally {
    closeSync(lockFd);
    unlinkSync(lock);
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    root: { type: 'string', default: '.' },
    target: { type: 'string', default: 'all' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log(help.trimEnd());
    return;
  }
  if (values.target !== 'all' && !targets.includes(values.target)) {
    throw new Error(`Unknown install target: ${values.target}\n${help.trimEnd()}`);
  }
  const root = realpathSync(resolve(values.root));
  if (!lstatSync(root).isDirectory()) throw new Error(`Project root is not a directory: ${root}`);
  const selectedTargets = values.target === 'all' ? targets : [values.target];
  const changes = install(root, await desiredFiles(selectedTargets));
  console.log(`Spindle adapters ready in ${root} (${selectedTargets.join(', ')}). ${changes} file(s) written.`);
  console.log('Run from that project with node .spindle/harness/bin/spin.js --help');
}

main().catch((error) => {
  console.error(`spindle-install: ${error.message}`);
  process.exitCode = 1;
});
