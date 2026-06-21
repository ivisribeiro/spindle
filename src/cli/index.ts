import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import {
  initHandler,
  stateHandler,
  nextHandler,
  orderHandler,
  completeHandler,
  validateHandler,
  gateHandler,
  diffCriteriaHandler,
  handoffCheckHandler,
  retryHandler,
  routeHandler,
  schemaHandler,
  listTaskKindsHandler,
  type HandlerResult,
} from '../commands/handlers.js';

// spin CLI. The deterministic harness spine. It NEVER calls a model — it manages
// the artifact graph, run-state, and gates. Exit-code ABI: 0 pass · 1 blocked ·
// 2 usage · 3 internal.

export type Writer = (chunk: string) => void;

export async function runCli(
  argv: string[],
  write: Writer = (chunk) => process.stdout.write(chunk)
): Promise<number> {
  let exitCode = 0;
  const emit = (r: HandlerResult): void => {
    write(JSON.stringify(r.json, null, 2) + '\n');
    exitCode = r.code;
  };
  const rootOf = (opts: { root?: string }): string => opts.root ?? process.cwd();

  const program = new Command();
  program
    .name('spin')
    .description('AgentSpec Harness — deterministic spec-driven orchestration spine')
    .version('0.1.0')
    .option('--root <dir>', 'project root containing .spindle/ (default: cwd)')
    .enablePositionalOptions();

  const root = (cmd: Command): string => rootOf(cmd.optsWithGlobals());

  program
    .command('init')
    .option('--schema <name>', 'workflow schema (sdd | kb)', 'sdd')
    .option('--feature <slug>', 'feature slug', 'feature')
    .action(function (this: Command, opts) {
      emit(initHandler(root(this), opts));
    });

  program
    .command('state')
    .action(function (this: Command) {
      emit(stateHandler(root(this)));
    });

  program
    .command('next')
    .action(function (this: Command) {
      emit(nextHandler(root(this)));
    });

  program
    .command('order')
    .action(function (this: Command) {
      emit(orderHandler(root(this)));
    });

  program
    .command('complete <id>')
    .option('--handoff <file>', 'worker-output JSON sidecar to validate')
    .action(function (this: Command, id, opts) {
      emit(completeHandler(root(this), id, opts));
    });

  program
    .command('validate <idOrPath>')
    .action(function (this: Command, idOrPath) {
      emit(validateHandler(root(this), idOrPath));
    });

  program
    .command('gate <gateId>')
    .option('--agents <dir>', 'agents dir (G_ROUTER_COVERAGE)')
    .option('--routing <file>', 'routing.json (G_ROUTER_COVERAGE)')
    .option('--findings <file>', 'findings.json (G_REVIEW_BLOCK)')
    .action(function (this: Command, gateId, opts) {
      const args: Record<string, string> = {};
      if (opts.agents) args.agents = opts.agents;
      if (opts.routing) args.routing = opts.routing;
      if (opts.findings) args.findings = opts.findings;
      emit(gateHandler(root(this), gateId, args));
    });

  program
    .command('diff-criteria')
    .requiredOption('--define <file>', 'define handoff JSON')
    .requiredOption('--build <file>', 'build-report handoff JSON')
    .action(function (this: Command, opts) {
      emit(diffCriteriaHandler(root(this), opts));
    });

  program
    .command('handoff-check <schemaId> <file>')
    .action(function (this: Command, schemaId, file) {
      emit(handoffCheckHandler(schemaId, file));
    });

  program
    .command('retry <id>')
    .option('--inc', 'increment the retry counter')
    .option('--ok', 'exit 1 if the retry ceiling was hit')
    .action(function (this: Command, id, opts) {
      emit(retryHandler(root(this), id, opts));
    });

  program
    .command('route <taskKind>')
    .option('--budget <level>', 'std | low', 'std')
    .action(function (this: Command, taskKind, opts) {
      emit(routeHandler(taskKind, opts));
    });

  program
    .command('kinds')
    .description('list known routing task-kinds')
    .action(function () {
      emit(listTaskKindsHandler());
    });

  program
    .command('schema <action>')
    .description('show | validate the active workflow schema')
    .action(function (this: Command, action) {
      emit(schemaHandler(root(this), action));
    });

  try {
    await program.parseAsync(argv);
  } catch (err) {
    process.stderr.write((err as Error).message + '\n');
    return 2;
  }
  return exitCode;
}

// Self-execute when run directly as the process entrypoint (e.g. the plugin
// commands invoke `node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js <args>`). When
// imported (bin/spin.js, vitest), this guard is false and nothing auto-runs.
// realpath-normalizes both sides so a symlinked path (macOS /var -> /private/var,
// or a symlinked install dir) still self-executes.
function isDirectEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntrypoint()) {
  runCli(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write((err?.stack || String(err)) + '\n');
      process.exit(3);
    }
  );
}
