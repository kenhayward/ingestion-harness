import { z } from 'zod';
import { STAGE_ORDER, type StageState, type StageView } from './drafting.js';
import { GateViewSchema, percent, type GateView } from './evaluation.js';
import { ProjectViewSchema, type Brief, type ProposalStatus } from './workbench.js';

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
  'references',
  'evaluate',
  'revise',
  'publish',
] as const;
export type OverviewStage = (typeof OVERVIEW_STAGES)[number];

/** `ready`: the publish gate passes; `locked`: it does not; `warn`: needs you, without a proposal. */
export type OverviewState = StageState | 'ready' | 'locked' | 'warn';

export const OVERVIEW_LABEL: Record<OverviewStage, string> = {
  samples: 'Samples',
  brief: 'Brief',
  survey: 'Survey',
  outputs: 'Outputs',
  sections: 'Sections',
  steps: 'Steps',
  references: 'References',
  evaluate: 'Evaluate',
  revise: 'Revise',
  publish: 'Publish',
};

export type OverviewPhase = 'prepare' | 'draft' | 'verify' | 'published';

export type NextActionKind =
  | 'refresh'
  | 'decide'
  | 'brief'
  | 'samples'
  | 'running'
  | 'below_threshold'
  | 'publish'
  | 'start_version'
  | 'continue';

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
  stages: readonly StageView[];
  /** The newest revise proposal's status; null when revise never ran. */
  revise: ProposalStatus | null;
  /** An evaluation of the open draft (dev or holdout) is queued or running. */
  evaluation: { running: boolean };
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
  references: 'verify',
  evaluate: 'verify',
  revise: 'verify',
  publish: 'verify',
};

const isDone = (state: OverviewState) => state === 'accepted' || state === 'skipped';

/** Revise is optional and Publish is the goal: neither is a step still to do. */
const firstToDo = (entries: readonly OverviewEntry[]) =>
  entries.find((e) => e.stage !== 'revise' && e.stage !== 'publish' && !isDone(e.state));

/** A brief counts as saved once any field or survey answer has text. */
export function briefSaved(brief: Brief | null): boolean {
  if (brief === null) return false;
  const { answers, ...text } = brief.body;
  return answers.length > 0 || Object.values(text).some((value) => value.trim() !== '');
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

/** The ten stages' states; with no open draft every stage is done. */
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
    references: drafted('references'),
    evaluate: evaluateState(inputs.evaluation, inputs.gate),
    revise: reviseState(inputs.revise),
    publish: inputs.gate.passes ? 'ready' : 'locked',
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
  const { gate } = inputs;
  // A holdout run decided the gate and it fails: below the threshold, or coverage/comparison incomplete.
  if (gate.iterationId !== null && !gate.passes) {
    const belowThreshold = gate.score !== null && gate.score < gate.threshold;
    const label = belowThreshold
      ? `Holdout below ${Math.round(gate.threshold * 100)}%`
      : 'Re-run holdout';
    return { kind: 'below_threshold', stage: 'evaluate', label };
  }
  if (gate.passes) return { kind: 'publish', stage: 'publish', label: `Publish v${inputs.draft}` };
  const todo = firstToDo(entries);
  return todo
    ? { kind: 'continue', stage: todo.stage, label: `Start ${OVERVIEW_LABEL[todo.stage]}` }
    : null;
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

/** The project page's tabs that show a status: the ten stages, then the by-hand tabs. */
export const OVERVIEW_TABS = [...OVERVIEW_STAGES, 'template', 'runs'] as const;
export type OverviewTab = (typeof OVERVIEW_TABS)[number];

export const OVERVIEW_TAB_LABEL: Record<OverviewTab, string> = {
  ...OVERVIEW_LABEL,
  template: 'Template',
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

export const OverviewItemSchema = z.object({
  stage: z.enum(OVERVIEW_TABS),
  /** `none`: Template, which has no status. */
  state: z.union([OverviewStateSchema, z.literal('none')]),
  /** Plain words after the stage name: "Stale — Outputs changed after it was accepted". */
  status: z.string(),
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
    .filter((s) => order.indexOf(s.stage) < order.indexOf(stage))
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
      return preparing > 0 ? `Preparing ${preparing} of ${total}` : 'Ready';
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
      return 'Not run on holdout yet';
    }
    case 'revise':
      if (state === 'running') return 'Running';
      if (state === 'proposed') return 'Needs your decision';
      if (state === 'accepted') return 'Applied';
      return ctx.openFeedback > 0 ? `${ctx.openFeedback} open` : 'No feedback';
    case 'publish':
      return state === 'ready' ? `Ready to publish v${inputs.draft}` : 'Locked by the gate';
    default:
      if (state === 'stale') {
        return `Stale — ${staleCauseLabel(inputs.stages, stage) ?? 'an earlier stage'} changed after it was accepted`;
      }
      if (stage === 'references' && state === 'accepted') return 'Verified';
      return DRAFTED[state] ?? 'Not started';
  }
}

/** Every tab's state and status text, in `OVERVIEW_TABS` order (the rail and the map). */
export function overviewItems(ctx: StatusContext): OverviewItem[] {
  const entries = overviewStates(ctx.inputs);
  const { draft, published } = ctx.inputs;
  const runs = runsState(ctx.runs);
  const runsText =
    runs === 'running'
      ? `${ctx.runs.unfinished} running`
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
    },
    { stage: 'runs' as const, state: runs, status: runsText },
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
              title: 'Next: add sample PDFs',
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
  const reason = action.kind === 'publish' ? sentence(inputs.gate.reason) : '';
  return { stage: action.stage, title: `Next: ${lowerFirst(action.label)}`, reason };
}
