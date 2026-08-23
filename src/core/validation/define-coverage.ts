// Deterministic discovery-coverage scoring for the DEFINE artifact.
//
// WHY THIS EXISTS. The `define` handoff carries a `clarity` number, but a WORKER
// writes it — so `config.clarity_floor` gates on the model's opinion of its own
// output. This module is the model-free counterweight: it derives coverage,
// decision-clarity and readiness from what is ACTUALLY on disk (the DEFINE.md
// prose + the criteria/open-questions the handoff declares), so the verdict does
// not depend on a self-report.
//
// SCOPE OF THE CLAIM. This is a STRUCTURAL measure — "does the artifact discuss
// this dimension" — not a semantic one, exactly like G_ROUTER_COVERAGE's
// kb_domains check is existence, NOT usage proof. A block counts as covered when
// its vocabulary appears in the prose. That is a floor against stub specs, never
// evidence that the dimension was reasoned about well.
//
// origin: boostprompt (MIT) — the coverage/decision-clarity/readiness formulas are
// adapted from its PromptQualityEvaluator. See CREDITS.md.

/** A discovery dimension a complete DEFINE is expected to touch. */
export interface DiscoveryBlock {
  id: string;
  /** Human label used in gate reasons. */
  label: string;
  /** Vocabulary that marks the block as discussed. Matched against normalized text. */
  terms: RegExp[];
}

/**
 * The nine discovery blocks. Terms are matched against diacritic-stripped,
 * lowercased text, so both English and pt-BR artifacts score the same way (the
 * SDD workflow is used in both languages; scoring must not punish either).
 */
export const DISCOVERY_BLOCKS: readonly DiscoveryBlock[] = [
  {
    id: 'problem',
    label: 'problem & context',
    terms: [/\bproblem/, /\bpain\b/, /\bmotivation/, /\bimpact/, /\bproblema/, /\bdor(es)?\b/, /\bmotivac/, /\bimpacto/],
  },
  {
    id: 'goals',
    label: 'goals & success signals',
    terms: [/\bgoal/, /\bobjective/, /\bsuccess/, /\bmetric/, /\bkpi\b/, /\boutcome/, /\bobjetivo/, /\bmeta(s)?\b/, /\bsucesso/, /\bmetrica/],
  },
  {
    id: 'users',
    label: 'users & stakeholders',
    terms: [/\buser/, /\bpersona/, /\bstakeholder/, /\boperator/, /\baudience/, /\busuario/, /\bator(es)?\b/, /\bpublico/],
  },
  {
    id: 'scope',
    label: 'functional scope',
    terms: [/\bscope\b/, /\bfeature/, /\bbehaviou?r/, /\bcapabilit/, /\bworkflow/, /\bescopo/, /\bfuncionalidade/, /\bregra(s)?\b/],
  },
  {
    id: 'nfr',
    label: 'non-functional requirements',
    terms: [/\bperformance/, /\blatenc/, /\bthroughput/, /\bcost(s)?\b/, /\bscalab/, /\bavailabilit/, /\bresilien/, /\bsla\b/, /\bdesempenho/, /\bcusto/, /\bescalab/, /\bdisponibilidade/],
  },
  {
    id: 'architecture',
    label: 'architecture & data',
    terms: [/\barchitect/, /\bcomponent/, /\bmodule/, /\bapi\b/, /\bendpoint/, /\bschema/, /\bstorage/, /\bpersist/, /\bqueue/, /\bcache/, /\barquitetur/, /\bcomponente/, /\bmodulo/, /\bbanco de dados/],
  },
  {
    id: 'security',
    label: 'security & compliance',
    terms: [/\bsecurity\b/, /\bauth/, /\bpermission/, /\bsecret(s)?\b/, /\bcredential/, /\bencrypt/, /\bprivacy/, /\bcomplian/, /\bpii\b/, /\blgpd\b/, /\bgdpr\b/, /\bseguranca/, /\bautentic/, /\bautoriz/, /\bcriptograf/, /\bprivacidade/],
  },
  {
    id: 'delivery',
    label: 'delivery & operation',
    terms: [/\bdeploy/, /\brollout/, /\brollback/, /\bci\b/, /\bcd\b/, /\bmigrat/, /\bmonitor/, /\bobservab/, /\btest/, /\benvironment/, /\bentrega/, /\bimplanta/, /\bteste(s)?\b/, /\bambiente/],
  },
  {
    id: 'constraints',
    label: 'constraints, assumptions & risks',
    terms: [/\bconstraint/, /\bassumption/, /\brisk(s)?\b/, /\btrade-?off/, /\blimitation/, /\bnon-goal/, /\bout of scope\b/, /\bdependenc/, /\brestric/, /\bpremissa/, /\brisco(s)?\b/, /\blimitac/],
  },
] as const;

/** The closed set of block ids — shared with the `brainstorm` handoff's blocks_covered[]. */
export const DISCOVERY_BLOCK_IDS: readonly string[] = DISCOVERY_BLOCKS.map((b) => b.id);

/** Number of acceptance criteria at which the criteria term of readiness saturates. */
const CRITERIA_SATURATION = 5;
/** Evidence ceiling — past this, more items stop buying clarity. */
const EVIDENCE_CEILING = 10;

export interface CoverageInput {
  /** The DEFINE.md prose. */
  markdown: string;
  /** Acceptance-criterion ids from the define handoff. */
  criteria: string[];
  /** Open questions from the define handoff — these are the UNCERTAINTY term. */
  openQuestions: string[];
}

export interface CoverageResult {
  /** 0..100 — share of the nine discovery blocks whose vocabulary appears. */
  coverage: number;
  /** 0..100 — evidence discounted by declared uncertainty. */
  decision_clarity: number;
  /** 0..100 — the weighted verdict `coverage_floor` compares against. */
  readiness: number;
  covered: string[];
  uncovered: string[];
}

/** Lowercase + strip combining marks so "segurança" and "seguranca" score alike. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Score a DEFINE artifact. Pure: same inputs -> same numbers, no I/O, no model.
 *
 * `decision_clarity` deliberately PENALIZES open questions: a DEFINE that
 * declares unresolved questions is more honest, but it is also less ready to be
 * designed against. The penalty lands on readiness, never on the honesty of
 * declaring them — the same split the KB E-1 rule makes with `decoding_note`.
 */
export function computeDefineCoverage(input: CoverageInput): CoverageResult {
  const text = normalizeText(input.markdown);
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const block of DISCOVERY_BLOCKS) {
    (block.terms.some((t) => t.test(text)) ? covered : uncovered).push(block.id);
  }

  const coverage = Math.round((covered.length / DISCOVERY_BLOCKS.length) * 100);
  const evidence = Math.min(EVIDENCE_CEILING, input.criteria.length + covered.length);
  const uncertainty = input.openQuestions.length;
  const decision_clarity = clamp(
    Math.round((100 * evidence) / (EVIDENCE_CEILING + 2 * uncertainty)),
    0,
    100
  );
  const criteriaTerm = Math.min(input.criteria.length / CRITERIA_SATURATION, 1) * 100;
  const readiness = Math.round(0.5 * coverage + 0.35 * decision_clarity + 0.15 * criteriaTerm);

  return { coverage, decision_clarity, readiness, covered, uncovered };
}
