import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { RunStateError } from '../core/run/run-state.js';
import { SchemaValidationError } from '../core/artifact-graph/schema.js';
import { ArtifactCycleError } from '../core/artifact-graph/graph.js';
import {
  initHandler,
  stateHandler,
  nextHandler,
  orderHandler,
  completeHandler,
  traceHandler,
  budgetHandler,
  fanoutCheckHandler,
  kbInstallHandler,
  mergeFindingsHandler,
  validateHandler,
  gateHandler,
  diffCriteriaHandler,
  handoffCheckHandler,
  retryHandler,
  routeHandler,
  tierHandler,
  schemaHandler,
  listTaskKindsHandler,
  reconcileHandler,
  configDriftHandler,
  explainHandler,
  specDriftHandler,
  evalHandler,
  approveHandler,
  invalidateHandler,
  doctorHandler,
  verifySelfHandler,
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
    .description('Spindle — deterministic spec-driven orchestration spine')
    .version('0.1.0')
    .option('--root <dir>', 'project root containing .spindle/ (default: cwd)')
    .enablePositionalOptions();

  const root = (cmd: Command): string => rootOf(cmd.optsWithGlobals());

  program
    .command('init')
    .option('--schema <name>', 'workflow schema (sdd | kb)', 'sdd')
    .option('--feature <slug>', 'feature slug', 'feature')
    .option(
      '--force',
      'overwrite an in-progress run anyway (one active run per checkout; a human decision — never pass this autonomously)'
    )
    .action(function (this: Command, opts) {
      emit(initHandler(root(this), opts));
    });

  program
    .command('state')
    .alias('status') // `status` is the conventional verb; agents reach for it first (dogfood F1)
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
    .command('trace')
    .description(
      'print the recorded run-ledger timeline + a tier/token summary (pure read, exit 0). --verify walks the events[] hash chain: exit 0 intact (adds chain:{verified,legacy}), exit 1 naming the first broken link'
    )
    .option('--verify', 'verify the events[] tamper-evident hash chain')
    .action(function (this: Command, opts) {
      emit(traceHandler(root(this), opts));
    });

  program
    .command('budget')
    .description(
      'reconcile reported token spend per tier against an optional ceiling. Advisory by default (always exit 0); --enforce opts into exit 1 on overage'
    )
    .option('--max-tokens <n>', 'ceiling; sets over_budget when reported spend exceeds it')
    .option(
      '--enforce',
      'exit 1 when reported spend exceeds the ceiling (--max-tokens, else config.max_tokens); exit 2 if no ceiling is available'
    )
    .action(function (this: Command, opts) {
      emit(budgetHandler(root(this), opts));
    });

  program
    .command('fanout-check')
    .description(
      'assert no parallel_group is partially complete (a dropped fan-out worker); exit 0 all-consistent / 1 partial. With --manifest: file-level mode — compare the design manifest against per-file build-task sidecars and list missing[] for re-dispatch'
    )
    .option(
      '--manifest <file>',
      'design handoff JSON whose manifest[] enumerates the fan-out units (enables file-level mode)'
    )
    .option(
      '--handoffs <dir>',
      "directory holding the per-file build-task sidecars (default: the active feature's .handoffs/)"
    )
    .action(function (this: Command, opts) {
      emit(fanoutCheckHandler(root(this), opts));
    });

  program
    .command('complete <id>')
    .option('--handoff <file>', 'worker-output JSON sidecar to validate')
    .action(function (this: Command, id, opts) {
      emit(completeHandler(root(this), id, opts));
    });

  program
    .command('invalidate <id>')
    .description('after editing a gated artifact: drop it + its downstream closure from the ledger and void all gate verdicts + approval, so no stale-green survives (the /iterate cascade)')
    .action(function (this: Command, id) {
      emit(invalidateHandler(root(this), id));
    });

  program
    .command('approve')
    .description('record human sign-off (required by G_SHIP). Refuses unless run in an interactive terminal — an agent cannot approve')
    .option('--by <name>', 'approver name (defaults to $USER)')
    .action(function (this: Command, opts) {
      emit(approveHandler(root(this), opts));
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
    .option('--kb <dir>', 'kb dir for kb_domains referential check (G_ROUTER_COVERAGE; default plugin/kb)')
    .option('--findings <file>', 'findings.json (G_REVIEW_BLOCK)')
    .option('--min-sources <n>', 'G_REVIEW_BLOCK: require >=n distinct review sources')
    .option('--handoff <file>', 'audit.json sidecar (G_AUDIT)')
    .option('--audit <file>', 'audit.json sidecar (G_OPS_CONFIG, G_PLAN)')
    .action(function (this: Command, gateId, opts) {
      const args: Record<string, string> = {};
      if (opts.agents) args.agents = opts.agents;
      if (opts.routing) args.routing = opts.routing;
      if (opts.kb) args.kb = opts.kb;
      if (opts.findings) args.findings = opts.findings;
      if (opts.minSources) args['min-sources'] = opts.minSources;
      if (opts.handoff) args.handoff = opts.handoff;
      if (opts.audit) args.audit = opts.audit;
      emit(gateHandler(root(this), gateId, args));
    });

  program
    .command('merge-findings <files...>')
    .description('deterministically merge N finding files (dedup by file+line+rule, keep higher severity, aggregate sources) into one {findings,sources} for G_REVIEW_BLOCK')
    .option('--out <file>', 'write the merged result here (else stdout)')
    .action(function (this: Command, files, opts) {
      emit(mergeFindingsHandler(root(this), files, opts));
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
    .command('route [taskKind]')
    .description(
      'resolve a task-kind to a model tier {tier,model,reason}. With no taskKind, --stats reports advisory per-tier completion/token accounting + per-artifact retry counts from the run ledger (always exit 0 once a run exists)'
    )
    .option('--budget <level>', 'std | low', 'std')
    .option('--stats', 'advisory routing accounting from the run ledger (used without taskKind)')
    .action(function (this: Command, taskKind, opts) {
      emit(routeHandler(root(this), taskKind, opts));
    });

  program
    .command('tier')
    .description('classify a task into an orchestration tier (T0/T1/T2) from its signals')
    .option('--risk <level>', 'low | medium | high', undefined)
    .option('--breadth <n>', 'single | few | many', undefined)
    .option('--mechanical', 'mechanical/template work (rename, config, doc from a result)')
    .option('--have-context', 'I already hold the material/context (re-derivation, not discovery)')
    .option('--reversible', 'the action is easily reversible')
    .option('--irreversible', 'the action is hard to reverse (deploy, delete, publish)')
    .action(function (this: Command, opts) {
      emit(tierHandler(opts));
    });

  program
    .command('kinds')
    .description('list known routing task-kinds')
    .action(function () {
      emit(listTaskKindsHandler());
    });

  program
    .command('kb-install <domain>')
    .description('publish a generated KB domain (flat layout) from .spindle/ into plugin/kb/ so kb_domains resolves; pure file copy, exit 1 if the source is incomplete')
    .option('--from <dir>', 'source dir (default .spindle/features/<domain>)')
    .option('--dest <dir>', 'destination kb root (default plugin/kb)')
    .action(function (this: Command, domain, opts) {
      emit(kbInstallHandler(root(this), domain, opts));
    });

  program
    .command('schema <action> [handoffId]')
    .description('show | validate the active workflow schema; `show <handoff-id>` describes a handoff JSON shape')
    .action(function (this: Command, action, handoffId) {
      emit(schemaHandler(root(this), action, handoffId));
    });

  program
    .command('explain <gateId>')
    .description('explain what a gate reads, what blocks it, and which flags apply')
    .action(function (this: Command, gateId) {
      emit(explainHandler(gateId));
    });

  program
    .command('spec-drift')
    .description(
      'surface acceptance criteria the build CORRECTED vs DEFINE (exit 1 if any spec drift is unreconciled)'
    )
    .requiredOption('--build <file>', 'build-report handoff JSON')
    .action(function (this: Command, opts) {
      emit(specDriftHandler(root(this), opts));
    });

  program
    .command('reconcile')
    .description('detect doc-vs-code drift in an audit handoff (exit 1 if inconsistent/drift items exist)')
    .requiredOption('--audit <file>', 'audit handoff JSON to reconcile')
    .action(function (this: Command, opts) {
      emit(reconcileHandler(root(this), opts));
    });

  program
    .command('eval')
    .description(
      'replay the eval corpus through the real gates; exit 1 on any verdict regression (--strict also requires every gate to have a pass+block case)'
    )
    .option('--corpus <dir>', 'eval corpus dir (default: bundled schemas/evals)')
    .option('--strict', 'also fail if any registry gate lacks a pass+block fixture')
    .action(function (this: Command, opts) {
      emit(evalHandler(opts));
    });

  program
    .command('config-drift')
    .description(
      'detect tools declared in CI but absent from the lockfile (exit 1 if any missing)'
    )
    .requiredOption('--declared <list>', 'comma-separated tools required by CI')
    .requiredOption('--present <list>', 'comma-separated tools found in the lockfile')
    .action(function (this: Command, opts) {
      emit(configDriftHandler(opts));
    });

  // --- spin doctor / spin verify-self: orientation + build-integrity diagnostics.
  // Kept as their own region so they never collide with edits to the commands above.

  program
    .command('doctor')
    .description(
      'read-only orientation + environment diagnosis: node version, active run, schema validity, and the exact next slash command. Always exit 0 unless the check itself crashes (3)'
    )
    .action(function (this: Command) {
      emit(doctorHandler(root(this)));
    });

  program
    .command('verify-self')
    .description(
      'recompute sha256 over dist/cli/index.js, plugin/dist/cli/index.js, and schemas/**+plugin/schemas/**, compare against verification/checksums.json; exit 1 lists mismatched/missing, exit 2 if the manifest is absent'
    )
    .option('--manifest <file>', 'checksum manifest (default: verification/checksums.json under --root)')
    .action(function (this: Command, opts) {
      emit(verifySelfHandler(root(this), opts));
    });

  try {
    await program.parseAsync(argv);
  } catch (err) {
    process.stderr.write((err as Error).message + '\n');
    // A corrupt/invalid ledger on disk is an INTERNAL failure (exit 3), not a usage
    // error. A missing ledger and ordinary bad-invocation errors stay usage (exit 2).
    if (err instanceof RunStateError && (err.kind === 'corrupt' || err.kind === 'invalid')) return 3;
    // Same precedent for the active workflow schema: `spin init`/`spin schema validate`
    // already validated it once (including the DFS/Kahn cycle checks), so a
    // SchemaValidationError or ArtifactCycleError surfacing while some OTHER command
    // (next/order/complete/...) loads it as supporting state means the on-disk copy went
    // bad after the fact — an internal/corrupt-state failure, not a bad invocation.
    // `schemaHandler`'s own `validate` action catches both locally and reports them as a
    // normal exit-1 domain block instead, so this branch never double-handles that path.
    if (err instanceof SchemaValidationError || err instanceof ArtifactCycleError) return 3;
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
