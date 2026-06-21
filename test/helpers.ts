import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../src/cli/index.js';

export interface CliResult {
  code: number;
  out: string;
  json: any;
}

/** Run the spin CLI in-process, capturing stdout. Exercises the full exit-code ABI. */
export async function cli(args: string[]): Promise<CliResult> {
  let buf = '';
  const code = await runCli(['node', 'spin', ...args], (c) => {
    buf += c;
  });
  let json: any;
  try {
    json = JSON.parse(buf);
  } catch {
    json = undefined;
  }
  return { code, out: buf, json };
}

export function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spin-test-'));
}

export function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

export function writeJson(root: string, rel: string, obj: unknown): string {
  write(root, rel, JSON.stringify(obj, null, 2));
  return path.join(root, rel);
}
