import type { StageState, StageView } from './drafting.js';
import type { GateView } from './evaluation.js';
import type { Brief, ProposalStatus } from './workbench.js';

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
  /** Evaluations of the open draft (dev or holdout): one is queued or running / one finished. */
  evaluation: { running: boolean; complete: boolean };
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

function evaluateState({ running, complete }: OverviewInputs['evaluation'], gate: GateView) {
  if (gate.passes) return 'accepted';
  if (running) return 'running';
  return complete ? 'warn' : 'pending';
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
  if (gate.score !== null && !gate.passes) {
    const percent = Math.round(gate.threshold * 100);
    return { kind: 'below_threshold', stage: 'evaluate', label: `Holdout below ${percent}%` };
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
  const todo = firstToDo(entries.filter((e) => e.state === 'pending'));
  return todo ? { stage: todo.stage, kind: 'pending' } : null;
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
