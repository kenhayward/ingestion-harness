import type { DraftProgress, DraftRun, DraftStage } from '@ih/shared';
import { formatDuration } from '../jobs/derive.js';

export type PhaseState = 'done' | 'current' | 'pending';

export interface RunPhase {
  key: string;
  label: string;
  state: PhaseState;
  /** What the current phase is doing in more words (samples read, the model's try). */
  detail: string | null;
  /** How long the current phase has run, mm:ss. */
  elapsed: string | null;
}

export interface RunView {
  /** "Queued for 01:15" / "Running for 03:02". */
  headline: string;
  phases: RunPhase[];
}

type Step = { key: string; label: string };

const QUEUED: Step = { key: 'queued', label: 'Waiting for a worker' };
const READING: Step = { key: 'reading-1', label: 'Reading the dev samples' };
const MODEL: Step = { key: 'model-1', label: 'Drafting with the model' };
const ANCHORS: Step = { key: 'anchors-1', label: 'Testing the anchors on the samples' };
const MODEL_2: Step = { key: 'model-2', label: 'Fixing the anchors that missed' };
const ANCHORS_2: Step = { key: 'anchors-2', label: 'Testing the fixed anchors' };
const SUGGESTIONS: Step = { key: 'suggestions-1', label: 'Queuing ontology suggestions' };

/** The phases a stage goes through, as far as this run's progress shows them. */
function stepsOf(stage: DraftStage, progress: DraftProgress | null): Step[] {
  const steps = [QUEUED, READING, MODEL];
  if (stage === 'sections' || progress?.phase === 'anchors') steps.push(ANCHORS);
  if (progress && progress.round > 1) steps.push(MODEL_2, ANCHORS_2);
  if (progress?.phase === 'suggestions') steps.push(SUGGESTIONS);
  return steps;
}

function detailOf(key: string, progress: DraftProgress | null): string | null {
  if (!progress) return null;
  if (key === READING.key) return `${progress.samples} sample${progress.samples === 1 ? '' : 's'}`;
  if ((key === MODEL.key || key === MODEL_2.key) && progress.attempt !== null) {
    // A streamed reply's count (an estimate: about four characters a token, thinking included),
    // and in a conversation with tools, the tool running now or the calls made so far.
    const calls = progress.toolCalls ?? 0;
    const parts = [
      progress.tokens != null
        ? `~${progress.tokens.toLocaleString('en-GB')} tokens received so far`
        : null,
      progress.tool
        ? progress.tool.summary
        : calls > 0
          ? `${calls} tool call${calls === 1 ? '' : 's'}`
          : null,
    ].filter((p): p is string => p !== null);
    const received = parts.length ? `${parts.join(' · ')}.` : null;
    if (progress.attempt > 1) {
      const again = `The first reply did not pass the checks: asking again (try ${progress.attempt} of ${progress.of}).`;
      return received ? `${again} ${received}` : again;
    }
    return received ?? 'This can take several minutes.';
  }
  return null;
}

/**
 * A queued or running drafting stage as the person follows it (issue #151): every phase it goes
 * through, done, current or still to come, with the current one's detail and time, and the
 * whole run's time. `now` is epoch milliseconds.
 */
export function draftRunView(stage: DraftStage, run: DraftRun, now: number): RunView {
  const since = Date.parse(run.since);
  const progress = run.progress;
  const current =
    run.status === 'queued'
      ? QUEUED.key
      : progress
        ? `${progress.phase}-${progress.phase === 'reading' || progress.phase === 'suggestions' ? 1 : progress.round}`
        : READING.key;
  // From when the phase (and the model's try) began: token counts come every few seconds.
  const started = progress && run.status === 'running' ? Date.parse(progress.phaseAt) : since;
  const steps = stepsOf(stage, progress);
  const at = steps.findIndex((s) => s.key === current);
  const seconds = (from: number) => formatDuration((now - from) / 1000);
  return {
    headline: `${run.status === 'queued' ? 'Queued' : 'Running'} for ${seconds(since)}`,
    phases: steps.map((s, i) => {
      const state: PhaseState = i < at ? 'done' : i === at ? 'current' : 'pending';
      return {
        ...s,
        state,
        // The samples read stay said; a model call's try only while it runs.
        detail:
          state === 'current' || (state === 'done' && s.key === READING.key)
            ? detailOf(s.key, progress)
            : null,
        elapsed: state === 'current' ? seconds(started) : null,
      };
    }),
  };
}
