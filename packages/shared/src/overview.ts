import { z } from 'zod';
import { BRIEF_SECTIONS, briefSectionText } from './brief.js';
import { RetirementSchema } from './retirement.js';
import { STAGE_ORDER, type StageState, type StageView } from './drafting.js';
import { GateViewSchema, percent, type GateView } from './evaluation.js';
import {
  DATA_POLICIES,
  ProjectSummarySchema,
  ProjectViewSchema,
  type Brief,
  type ProjectSummary,
  type ProposalStatus,
} from './workbench.js';

/**
 * The ten steps of a document type as the Workbench list and Overview map show them
 * (docs/design/workbench-redesign/WORKBENCH-HANDOFF.md). Derived, never stored.
 */
export const OVERVIEW_STAGES = [
  'samples',
  'brief',
  'survey',
  'outputs',
  'sections',
  'steps',
  'mapping',
  'references',
  'evaluate',
  'revise',
  'publish',
] as const;
export type OverviewStage = (typeof OVERVIEW_STAGES)[number];

/**
 * `ready`: the open draft can be published (the gate is informational and never locks it);
 * `locked`: kept for older clients, no longer derived; `warn`: needs you, without a proposal.
 */
export type OverviewState = StageState | 'ready' | 'locked' | 'warn';

export const OVERVIEW_LABEL: Record<OverviewStage, string> = {
  samples: 'Samples',
  brief: 'Brief',
  survey: 'Survey',
  outputs: 'Outputs',
  sections: 'Sections',
  steps: 'Steps',
  mapping: 'Mapping',
  references: 'References',
  evaluate: 'Evaluate',
  revise: 'Revise',
  publish: 'Publish',
};

export const OVERVIEW_PHASES = ['prepare', 'draft', 'verify', 'published'] as const;
export type OverviewPhase = (typeof OVERVIEW_PHASES)[number];

export const NEXT_ACTION_KINDS = [
  'refresh',
  'decide',
  'brief',
  'samples',
  'running',
  'below_threshold',
  'publish',
  'start_version',
  'continue',
] as const;
export type NextActionKind = (typeof NEXT_ACTION_KINDS)[number];

export interface NextAction {
  kind: NextActionKind;
  stage: OverviewStage | null;
  label: string;
}

export interface OverviewInputs {
  /** The open draft version; null when every version is published. */
  draft: number | null;
  published: number | null;
  /** See `briefSaved`. */
  briefSaved: boolean;
  /** Dev and holdout samples: all of them, those still preparing, those whose prepare failed. */
  samples: { total: number; preparing: number; failed: number };
  /** Survey, outputs, sections, steps and references, as `GET /stages` returns them. */
  stages: readonly Pick<StageView, 'stage' | 'state' | 'completedAt'>[];
  /** The newest revise proposal's status; null when revise never ran. */
  revise: ProposalStatus | null;
  /**
   * The mapping stage (ADR 0011): `used` once the brief chooses a vocabulary ontology, and its
   * state (`mappingStage`). Absent: not used.
   */
  mapping?: { used: boolean; state: StageState };
  /**
   * `running`: an evaluation of the open draft (dev or holdout) is queued or running.
   * `revisedSince`: a revision was applied to the open draft after its newest evaluation (or it
   * has none), so the next step is to see whether the revision helped (absent: false).
   */
  evaluation: { running: boolean; revisedSince?: boolean };
  gate: GateView;
}

export interface OverviewEntry {
  stage: OverviewStage;
  state: OverviewState;
}

export type UrgencyKind = 'stale' | 'proposed' | 'gate' | 'samples' | 'brief' | 'pending';

const PHASE: Record<OverviewStage, Exclude<OverviewPhase, 'published'>> = {
  samples: 'prepare',
  brief: 'prepare',
  survey: 'draft',
  outputs: 'draft',
  sections: 'draft',
  steps: 'draft',
  mapping: 'draft',
  references: 'verify',
  evaluate: 'verify',
  revise: 'verify',
  publish: 'verify',
};

const isDone = (state: OverviewState) => state === 'accepted' || state === 'skipped';

/** Stages a draft can be published without: verification is optional. */
export const OPTIONAL_STAGES: readonly OverviewStage[] = [
  'mapping',
  'references',
  'evaluate',
  'revise',
];

/** Optional stages and Publish (the goal) are never a step still to do. */
const firstToDo = (entries: readonly OverviewEntry[]) =>
  entries.find(
    (e) => !OPTIONAL_STAGES.includes(e.stage) && e.stage !== 'publish' && !isDone(e.state),
  );

/** A brief counts as saved once any field or survey answer has text. */
export function briefSaved(brief: Brief | null): boolean {
  if (brief === null) return false;
  return BRIEF_SECTIONS.some((section) => briefSectionText(brief.body, section).trim() !== '');
}

function samplesState({ total, preparing, failed }: OverviewInputs['samples']): OverviewState {
  if (total === 0 || failed > 0) return 'warn';
  return preparing > 0 ? 'running' : 'accepted';
}

function reviseState(status: ProposalStatus | null): OverviewState {
  if (status === 'running') return 'running';
  if (status === 'ready') return 'proposed';
  if (status === 'accepted' || status === 'partially_accepted') return 'accepted';
  return 'pending';
}

function evaluateState({ running }: OverviewInputs['evaluation'], gate: GateView): OverviewState {
  if (gate.passes) return 'accepted';
  if (running) return 'running';
  // Only a holdout run of this draft that decided the gate can fail it; a dev-only evaluation is not a failing gate.
  return gate.iterationId !== null ? 'warn' : 'pending';
}

/** The stages' states; with no open draft every stage is done. */
export function overviewStates(inputs: OverviewInputs): OverviewEntry[] {
  if (inputs.draft === null) return OVERVIEW_STAGES.map((stage) => ({ stage, state: 'accepted' }));
  const drafted = (stage: OverviewStage): OverviewState =>
    inputs.stages.find((s) => s.stage === stage)?.state ?? 'pending';
  const state: Record<OverviewStage, OverviewState> = {
    samples: samplesState(inputs.samples),
    brief: inputs.briefSaved ? 'accepted' : 'warn',
    survey: drafted('survey'),
    outputs: drafted('outputs'),
    sections: drafted('sections'),
    steps: drafted('steps'),
    mapping: inputs.mapping?.used ? inputs.mapping.state : 'skipped',
    references: drafted('references'),
    evaluate: evaluateState(inputs.evaluation, inputs.gate),
    revise: reviseState(inputs.revise),
    publish: 'ready',
  };
  return OVERVIEW_STAGES.map((stage) => ({ stage, state: state[stage] }));
}

/** The phase of the first stage still to do, and how many stages are accepted or skipped. */
export function phaseOf(
  entries: readonly OverviewEntry[],
  draft: number | null,
): { phase: OverviewPhase; done: number } {
  const done = entries.filter((e) => isDone(e.state)).length;
  if (draft === null) return { phase: 'published', done };
  const todo = firstToDo(entries);
  return { phase: todo ? PHASE[todo.stage] : 'verify', done };
}

/** What the person should do next (the list's Next action column); first match wins. */
export function nextAction(
  inputs: OverviewInputs,
  entries: readonly OverviewEntry[] = overviewStates(inputs),
): NextAction | null {
  if (inputs.draft === null) {
    return { kind: 'start_version', stage: null, label: `Start v${(inputs.published ?? 0) + 1}` };
  }
  const first = (state: OverviewState) => entries.find((e) => e.state === state)?.stage;
  const stale = first('stale');
  if (stale) return { kind: 'refresh', stage: stale, label: `Refresh ${OVERVIEW_LABEL[stale]}` };
  const proposed = first('proposed');
  if (proposed) {
    return { kind: 'decide', stage: proposed, label: `Decide on ${OVERVIEW_LABEL[proposed]}` };
  }
  if (!inputs.briefSaved) return { kind: 'brief', stage: 'brief', label: 'Write the brief' };
  if (inputs.samples.total === 0)
    return { kind: 'samples', stage: 'samples', label: 'Add samples' };
  if (inputs.samples.failed > 0) return { kind: 'samples', stage: 'samples', label: 'Fix samples' };
  const running = first('running');
  if (running) {
    return { kind: 'running', stage: running, label: `${OVERVIEW_LABEL[running]} running` };
  }
  // A revision nobody has evaluated yet: evaluate it on dev before deciding anything else.
  if (inputs.evaluation.revisedSince) {
    return { kind: 'continue', stage: 'evaluate', label: `Evaluate v${inputs.draft} on dev` };
  }
  const { gate } = inputs;
  // A holdout run decided the gate and it fails: below the threshold, or coverage/comparison incomplete.
  if (gate.iterationId !== null && !gate.passes) {
    const belowThreshold = gate.score !== null && gate.score < gate.threshold;
    const label = belowThreshold
      ? `Holdout below ${Math.round(gate.threshold * 100)}%`
      : 'Re-run holdout';
    return { kind: 'below_threshold', stage: 'evaluate', label };
  }
  const todo = firstToDo(entries);
  return todo
    ? { kind: 'continue', stage: todo.stage, label: `Start ${OVERVIEW_LABEL[todo.stage]}` }
    : { kind: 'publish', stage: 'publish', label: `Publish v${inputs.draft}` };
}

/**
 * The most urgent stage for the Overview's Next banner: stale > proposal waiting > gate failing
 * > samples missing or failed > empty brief > first stage not started.
 */
export function urgency(
  inputs: OverviewInputs,
  entries: readonly OverviewEntry[] = overviewStates(inputs),
): { stage: OverviewStage; kind: UrgencyKind } | null {
  if (inputs.draft === null) return null;
  const first = (state: OverviewState) => entries.find((e) => e.state === state)?.stage;
  const stale = first('stale');
  if (stale) return { stage: stale, kind: 'stale' };
  const proposed = first('proposed');
  if (proposed) return { stage: proposed, kind: 'proposed' };
  if (entries.find((e) => e.stage === 'evaluate')?.state === 'warn') {
    return { stage: 'evaluate', kind: 'gate' };
  }
  if (entries.find((e) => e.stage === 'samples')?.state === 'warn') {
    return { stage: 'samples', kind: 'samples' };
  }
  if (!inputs.briefSaved) return { stage: 'brief', kind: 'brief' };
  const todo = firstToDo(entries);
  return todo && todo.state === 'pending' ? { stage: todo.stage, kind: 'pending' } : null;
}

/** The Test runs tab: any unfinished → running; any awaiting review → needs you. */
export function runsState(runs: {
  total: number;
  unfinished: number;
  awaitingReview: number;
}): OverviewState {
  if (runs.unfinished > 0) return 'running';
  if (runs.awaitingReview > 0) return 'warn';
  return runs.total > 0 ? 'accepted' : 'pending';
}

/** The project page's tabs that show a status: the stages, then the by-hand tabs. */
export const OVERVIEW_TABS = [...OVERVIEW_STAGES, 'template', 'runs'] as const;
export type OverviewTab = (typeof OVERVIEW_TABS)[number];

export const OVERVIEW_TAB_LABEL: Record<OverviewTab, string> = {
  ...OVERVIEW_LABEL,
  template: 'Recipe',
  runs: 'Test runs',
};

export const OverviewStateSchema = z.enum([
  'pending',
  'running',
  'proposed',
  'accepted',
  'skipped',
  'stale',
  'ready',
  'locked',
  'warn',
]);

export const OverviewMetricSchema = z.object({
  label: z.string(),
  value: z.string(),
  /** An ISO time the web shows as relative time; `value` is then the fallback text. */
  at: z.string().nullable(),
});
export type OverviewMetric = z.infer<typeof OverviewMetricSchema>;

/** Plain numbers the API gathers for the map's figures (null = not known yet). */
export interface MetricFacts {
  samples: { dev: number; holdout: number; ocrPages: number; pages: number };
  brief: { answers: number; updatedAt: string | null };
  template: { steps: number; sections: number; editedAt: string | null };
  runs: { total: number; awaitingReview: number };
  survey: { answered: number; questions: number; fields: number | null; tables: number | null };
  outputs: { fields: number; tables: number; applied: number | null; proposed: number | null };
  sections: { anchorsFound: number | null; devSamples: number };
  steps: { proposed: number | null; model: string | null };
  /** Outputs the open draft maps, of all its outputs; the brief's vocabulary ontologies. */
  mapping: { mapped: number; outputs: number; ontologies: number };
  references: {
    devVerified: number;
    devTotal: number;
    holdoutVerified: number;
    holdoutTotal: number;
  };
  evaluate: { dev: number | null; holdout: number | null };
  revise: { open: number; lastAt: string | null };
  publish: { live: number | null };
}

export const EMPTY_FACTS: MetricFacts = {
  samples: { dev: 0, holdout: 0, ocrPages: 0, pages: 0 },
  brief: { answers: 0, updatedAt: null },
  template: { steps: 0, sections: 0, editedAt: null },
  runs: { total: 0, awaitingReview: 0 },
  survey: { answered: 0, questions: 0, fields: null, tables: null },
  outputs: { fields: 0, tables: 0, applied: null, proposed: null },
  sections: { anchorsFound: null, devSamples: 0 },
  steps: { proposed: null, model: null },
  mapping: { mapped: 0, outputs: 0, ontologies: 0 },
  references: { devVerified: 0, devTotal: 0, holdoutVerified: 0, holdoutTotal: 0 },
  evaluate: { dev: null, holdout: null },
  revise: { open: 0, lastAt: null },
  publish: { live: null },
};

const DASH = '—';
const m = (label: string, value: string, at: string | null = null): OverviewMetric => ({
  label,
  value,
  at,
});
const n = (x: number | null) => (x === null ? DASH : String(x));
const pair = (a: number | null, b: number | null) =>
  a === null || b === null ? DASH : `${a} · ${b}`;
const score = (x: number | null) => (x === null ? DASH : percent(x));

/** The two figures of each Overview map box (handoff §3 metrics table). */
export function boxMetrics(
  f: MetricFacts,
  inputs: OverviewInputs,
): Record<OverviewTab, OverviewMetric[]> {
  const { survey, outputs } = f;
  return {
    samples: [
      m('Dev · holdout', `${f.samples.dev} · ${f.samples.holdout}`),
      m('OCR pages', f.samples.pages > 0 ? `${f.samples.ocrPages} of ${f.samples.pages}` : DASH),
    ],
    brief: [m('Answers', String(f.brief.answers)), m('Updated', DASH, f.brief.updatedAt)],
    template: [
      m('Steps · sections', `${f.template.steps} · ${f.template.sections}`),
      m('Hand edit', DASH, f.template.editedAt),
    ],
    runs: [m('Runs', String(f.runs.total)), m('Awaiting review', String(f.runs.awaitingReview))],
    survey: [
      m(
        'Questions',
        survey.questions > 0 ? `${survey.answered} of ${survey.questions} answered` : DASH,
      ),
      m('Fields · tables', pair(survey.fields, survey.tables)),
    ],
    outputs: [
      m('Fields · tables', `${outputs.fields} · ${outputs.tables}`),
      m(
        'Changes applied',
        outputs.applied === null || outputs.proposed === null
          ? DASH
          : `${outputs.applied} of ${outputs.proposed}`,
      ),
    ],
    sections: [
      m('Sections', String(f.template.sections)),
      m(
        'Anchors found',
        f.sections.anchorsFound === null
          ? DASH
          : `${f.sections.anchorsFound} / ${f.sections.devSamples} dev`,
      ),
    ],
    steps: [m('Proposed changes', n(f.steps.proposed)), m('Model', f.steps.model ?? DASH)],
    mapping: [
      m('Mapped outputs', `${f.mapping.mapped} / ${f.mapping.outputs}`),
      m('Ontologies', String(f.mapping.ontologies)),
    ],
    references: [
      m('Dev', `${f.references.devVerified} / ${f.references.devTotal}`),
      m('Holdout', `${f.references.holdoutVerified} / ${f.references.holdoutTotal}`),
    ],
    evaluate: [
      m('Dev score', score(f.evaluate.dev)),
      m('Holdout score', score(f.evaluate.holdout)),
    ],
    revise: [m('Feedback items', String(f.revise.open)), m('Last revision', DASH, f.revise.lastAt)],
    publish: [
      m('Needs holdout', `≥ ${percent(inputs.gate.threshold)}`),
      m('Live version', f.publish.live === null ? DASH : `v${f.publish.live}`),
    ],
  };
}

export const OverviewItemSchema = z.object({
  stage: z.enum(OVERVIEW_TABS),
  /** `none`: Template, which has no status. */
  state: z.union([OverviewStateSchema, z.literal('none')]),
  /** Plain words after the stage name: "Stale — Outputs changed after it was accepted". */
  status: z.string(),
  /** Two figures for the Overview map box (handoff §3). */
  metrics: z.array(OverviewMetricSchema).max(2),
});
export type OverviewItem = z.infer<typeof OverviewItemSchema>;

export const OverviewNextSchema = z.object({
  stage: z.enum(OVERVIEW_STAGES),
  title: z.string(),
  reason: z.string(),
});
export type OverviewNext = z.infer<typeof OverviewNextSchema>;

/** GET /api/workbench/projects/:id/overview (handoff W2): the rail, header and Overview tab. */
export const ProjectOverviewSchema = z.object({
  project: ProjectViewSchema,
  stages: z.array(OverviewItemSchema),
  next: OverviewNextSchema.nullable(),
  gate: GateViewSchema,
});
export type ProjectOverview = z.infer<typeof ProjectOverviewSchema>;

export interface StatusContext {
  inputs: OverviewInputs;
  /** The latest brief's version; null when none is saved. */
  briefVersion: number | null;
  /** The project's jobs except sample preparation (Test runs tab). */
  runs: { total: number; unfinished: number; awaitingReview: number };
  /** Feedback items no revise proposal has answered yet. */
  openFeedback: number;
  facts: MetricFacts;
}

/** "holdout score …" → "Holdout score ….": gate reasons are sentence fragments. */
const sentence = (s: string) =>
  `${s.charAt(0).toUpperCase()}${s.slice(1)}${s.endsWith('.') ? '' : '.'}`;
const lowerFirst = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;

const DRAFTED: Partial<Record<OverviewState, string>> = {
  accepted: 'Accepted',
  skipped: 'Skipped',
  proposed: 'Needs your decision',
  running: 'Running',
  pending: 'Not started',
};

/** The latest-completed earlier stage that completed after `stage`: why `stage` is stale. */
function staleCauseLabel(stages: OverviewInputs['stages'], stage: OverviewStage): string | null {
  const order: readonly string[] = [...STAGE_ORDER, 'references'];
  const own = stages.find((s) => s.stage === stage)?.completedAt ?? null;
  const cause = stages
    .filter((s) => order.includes(s.stage) && order.indexOf(s.stage) < order.indexOf(stage))
    .filter((s) => s.completedAt !== null && own !== null && s.completedAt > own)
    .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))[0];
  return cause ? OVERVIEW_LABEL[cause.stage as OverviewStage] : null;
}

function statusText(stage: OverviewStage, state: OverviewState, ctx: StatusContext): string {
  const { inputs } = ctx;
  if (inputs.draft === null) {
    if (inputs.published === null) return 'Not published';
    return stage === 'publish' ? `v${inputs.published} published` : 'Done';
  }
  switch (stage) {
    case 'samples': {
      const { total, preparing, failed } = inputs.samples;
      if (total === 0) return 'No samples yet';
      if (failed > 0) return `${failed} failed`;
      return preparing > 0 ? `${preparing} of ${total} preparing` : 'Ready';
    }
    case 'brief':
      return state === 'accepted'
        ? ctx.briefVersion === null
          ? 'Saved'
          : `Saved v${ctx.briefVersion}`
        : 'Not written yet';
    case 'evaluate': {
      const { gate } = inputs;
      if (state === 'accepted') return `Holdout ${percent(gate.score ?? 0)} passes`;
      if (state === 'running') return 'Running';
      if (state === 'warn') {
        if (gate.score !== null && gate.score < gate.threshold) {
          const digits = percent(gate.score) === percent(gate.threshold) ? 1 : 0;
          return `Holdout ${percent(gate.score, digits)}, below ${percent(gate.threshold, digits)}`;
        }
        return 'Re-run holdout';
      }
      return 'Optional, not run on holdout yet';
    }
    case 'revise':
      if (state === 'running') return 'Running';
      if (state === 'proposed') return 'Needs your decision';
      if (state === 'accepted') return 'Applied';
      return ctx.openFeedback > 0 ? `${ctx.openFeedback} open` : 'No feedback';
    case 'mapping':
      if (!inputs.mapping?.used) return 'Not used: no vocabulary is pinned on Survey';
      if (state === 'stale') return "Stale — the outputs or the brief's ontologies changed";
      if (state === 'accepted') return 'Mapped';
      if (state === 'pending') return 'Optional, not started';
      return DRAFTED[state] ?? 'Not started';
    case 'publish':
      return `Ready to publish v${inputs.draft}`;
    default:
      if (state === 'stale') {
        return `Stale — ${staleCauseLabel(inputs.stages, stage) ?? 'an earlier stage'} changed after it was accepted`;
      }
      if (stage === 'references' && state === 'accepted') return 'Verified';
      if (stage === 'references' && state === 'pending') return 'Optional, not started';
      return DRAFTED[state] ?? 'Not started';
  }
}

/** Every tab's state and status text, in `OVERVIEW_TABS` order (the rail and the map). */
export function overviewItems(ctx: StatusContext): OverviewItem[] {
  const entries = overviewStates(ctx.inputs);
  const { draft, published } = ctx.inputs;
  const runs = runsState(ctx.runs);
  const metrics = boxMetrics(ctx.facts, ctx.inputs);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const awaiting =
    ctx.runs.awaitingReview > 0 ? ` · ${ctx.runs.awaitingReview} awaiting review` : '';
  const runsText =
    runs === 'running'
      ? `${plural(ctx.runs.unfinished, 'test run')} in progress${awaiting}`
      : runs === 'warn'
        ? `${ctx.runs.awaitingReview} awaiting review`
        : runs === 'accepted'
          ? `${ctx.runs.total} finished`
          : 'No runs yet';
  return [
    ...entries.map((e) => ({
      stage: e.stage,
      state: e.state,
      status: statusText(e.stage, e.state, ctx),
      metrics: metrics[e.stage],
    })),
    {
      stage: 'template' as const,
      state: 'none' as const,
      status:
        draft !== null
          ? `Draft v${draft}`
          : published !== null
            ? `v${published} published`
            : 'Not published',
      metrics: metrics.template,
    },
    { stage: 'runs' as const, state: runs, status: runsText, metrics: metrics.runs },
  ];
}

/**
 * The Overview's Next banner: the most urgent stage (`urgency`), else what to do next
 * (`nextAction`); null with no open draft.
 */
export function overviewNext(
  inputs: OverviewInputs,
  entries: readonly OverviewEntry[] = overviewStates(inputs),
): OverviewNext | null {
  if (inputs.draft === null) return null;
  const u = urgency(inputs, entries);
  if (u) {
    const label = OVERVIEW_LABEL[u.stage];
    const { gate, samples } = inputs;
    switch (u.kind) {
      case 'stale':
        return {
          stage: u.stage,
          title: `Next: refresh ${label}`,
          reason: `${staleCauseLabel(inputs.stages, u.stage) ?? 'An earlier stage'} changed after ${label} was accepted.`,
        };
      case 'proposed':
        return {
          stage: u.stage,
          title: `Next: decide on ${label}`,
          reason: 'A proposal is waiting for your decision.',
        };
      case 'gate':
        return {
          stage: u.stage,
          title:
            gate.score !== null && gate.score < gate.threshold
              ? 'Next: raise the holdout score'
              : 'Next: re-run the holdout evaluation',
          reason: sentence(gate.reason),
        };
      case 'samples':
        return samples.total === 0
          ? {
              stage: u.stage,
              title: 'Next: add sample documents',
              reason: 'Upload 3–8 dev samples and a few holdout samples.',
            }
          : {
              stage: u.stage,
              title: 'Next: fix the failed samples',
              reason: `${samples.failed} ${samples.failed === 1 ? 'sample' : 'samples'} could not be prepared.`,
            };
      case 'brief':
        return {
          stage: u.stage,
          title: 'Next: write the brief',
          reason: 'Describe the document and what to extract from it.',
        };
      case 'pending':
        return {
          stage: u.stage,
          title: `Next: start ${label}`,
          reason: 'The stages before it are done.',
        };
    }
  }
  const action = nextAction(inputs, entries);
  if (!action || action.stage === null) return null;
  if (action.kind === 'running') {
    const label = OVERVIEW_LABEL[action.stage];
    return {
      stage: action.stage,
      title: `Waiting for ${label}`,
      reason:
        action.stage === 'samples'
          ? 'Samples are being prepared; this page updates when they finish.'
          : `The ${label} stage is running; this page updates when it finishes.`,
    };
  }
  const reason =
    action.kind === 'continue' && action.stage === 'evaluate'
      ? 'A revision was applied since the last evaluation: see whether it helped.'
      : action.kind !== 'publish'
        ? ''
        : inputs.gate.passes
          ? sentence(inputs.gate.reason)
          : 'References and evaluation are optional.';
  return { stage: action.stage, title: `Next: ${lowerFirst(action.label)}`, reason };
}

export const LIST_FILTERS = [
  'all',
  'attention',
  'running',
  'ready',
  'progress',
  'published',
] as const;
export const LIST_SORTS = ['activity', 'name', 'score', 'samples'] as const;
export const PAGE_SIZES = [25, 50, 100] as const;

export const ProjectListQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    filter: z.enum(LIST_FILTERS).default('all'),
    phase: z.enum(OVERVIEW_PHASES).optional(),
    policy: z.enum(DATA_POLICIES).optional(),
    /** `include`: list retired document types too (default: left out unless `ids` names them). */
    retired: z.enum(['include']).optional(),
    sort: z.enum(LIST_SORTS).default('activity'),
    /** Comma-separated project ids (at most 20): only those rows (the list's pinned and recent cards). */
    ids: z
      .string()
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      )
      .refine((a) => a.length <= 20, 'at most 20 ids')
      // `ids=` or `ids=,` names nothing: no filter, not "match nothing".
      .transform((a) => (a.length ? a : undefined))
      .optional(),
    page: z.coerce.number().int().min(1).default(1),
    size: z.coerce
      .number()
      .int()
      .refine((n) => (PAGE_SIZES as readonly number[]).includes(n), 'size must be 25, 50 or 100')
      .default(25),
  })
  .strict();
export type ProjectListQuery = z.infer<typeof ProjectListQuerySchema>;

export const ProjectListItemSchema = ProjectSummarySchema.extend({
  stages: z
    .array(z.object({ stage: z.enum(OVERVIEW_STAGES), state: OverviewStateSchema }))
    .length(OVERVIEW_STAGES.length),
  phase: z.enum(OVERVIEW_PHASES),
  done: z.number().int().min(0).max(OVERVIEW_STAGES.length),
  next: z
    .object({
      kind: z.enum(NEXT_ACTION_KINDS),
      stage: z.enum(OVERVIEW_STAGES).nullable(),
      label: z.string(),
    })
    .nullable(),
  /** Latest complete holdout score of the draft (else of the live version); null when none. */
  holdoutScore: z.number().nullable(),
  devSamples: z.number().int(),
  holdoutSamples: z.number().int(),
  lastActivityAt: z.string(),
  /** What the facets count (running also covers unfinished runs, which no stage shows). */
  flags: z.object({ attention: z.boolean(), running: z.boolean(), ready: z.boolean() }),
  /** Live, never cached: the list route overlays it on every request (null when active). */
  retired: RetirementSchema.nullable(),
});
export type ProjectListItem = z.infer<typeof ProjectListItemSchema>;

const FacetsSchema = z.object(
  Object.fromEntries(LIST_FILTERS.map((f) => [f, z.number().int()])) as Record<
    (typeof LIST_FILTERS)[number],
    z.ZodNumber
  >,
);
export const ProjectListPageSchema = z.object({
  items: z.array(ProjectListItemSchema),
  total: z.number().int(),
  facets: FacetsSchema,
});
export type ProjectListPage = z.infer<typeof ProjectListPageSchema>;

/** One list row from the same inputs the project page uses. */
export function listItemFrom(input: {
  summary: ProjectSummary;
  inputs: OverviewInputs;
  runsUnfinished: number;
  holdoutScore: number | null;
  devSamples: number;
  holdoutSamples: number;
  lastActivityAt: string;
}): ProjectListItem {
  const entries = overviewStates(input.inputs);
  const { phase, done } = phaseOf(entries, input.inputs.draft);
  const has = (...states: OverviewState[]) => entries.some((e) => states.includes(e.state));
  return {
    ...input.summary,
    stages: entries.map((e) => ({ stage: e.stage, state: e.state })),
    phase,
    done,
    next: nextAction(input.inputs, entries),
    holdoutScore: input.holdoutScore,
    devSamples: input.devSamples,
    holdoutSamples: input.holdoutSamples,
    lastActivityAt: input.lastActivityAt,
    retired: null,
    flags: {
      attention: has('stale', 'proposed', 'warn'),
      running: has('running') || input.runsUnfinished > 0 || input.inputs.evaluation.running,
      ready: input.inputs.draft !== null && firstToDo(entries) === undefined,
    },
  };
}

const inFacet = (f: (typeof LIST_FILTERS)[number], i: ProjectListItem) =>
  f === 'all' ||
  (f === 'attention' && i.flags.attention) ||
  (f === 'running' && i.flags.running) ||
  (f === 'ready' && i.flags.ready) ||
  (f === 'progress' && i.draft !== null) ||
  (f === 'published' && i.draft === null);

const ORDER: Record<
  (typeof LIST_SORTS)[number],
  (a: ProjectListItem, b: ProjectListItem) => number
> = {
  activity: (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt),
  name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  score: (a, b) =>
    a.holdoutScore === b.holdoutScore
      ? 0
      : a.holdoutScore === null
        ? 1
        : b.holdoutScore === null
          ? -1
          : a.holdoutScore - b.holdoutScore,
  samples: (a, b) => a.samples - b.samples,
};

/** Search, phase and policy, then facet counts, the filter chip, the sort and the page (handoff W1). */
export function queryProjects(
  items: readonly ProjectListItem[],
  query: ProjectListQuery,
): ProjectListPage {
  const needle = query.q?.toLowerCase() ?? '';
  // Retired projects only when asked for, or when named (the pinned and recent cards).
  const showRetired = query.retired === 'include' || query.ids !== undefined;
  const base = items.filter(
    (i) =>
      (showRetired || i.retired === null) &&
      (needle === '' ||
        i.name.toLowerCase().includes(needle) ||
        i.id.toLowerCase().includes(needle)) &&
      (query.ids === undefined || query.ids.includes(i.id)) &&
      (query.phase === undefined || i.phase === query.phase) &&
      (query.policy === undefined || i.dataPolicy === query.policy),
  );
  const facets = Object.fromEntries(
    LIST_FILTERS.map((f) => [f, base.filter((i) => inFacet(f, i)).length]),
  ) as ProjectListPage['facets'];
  const sorted = base
    .filter((i) => inFacet(query.filter, i))
    .sort((a, b) => ORDER[query.sort](a, b) || a.id.localeCompare(b.id));
  const start = (query.page - 1) * query.size;
  return { items: sorted.slice(start, start + query.size), total: sorted.length, facets };
}
