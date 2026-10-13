import {
  changeBodyOf,
  FEEDBACK_TARGET_ID,
  STAGE_ORDER,
  type DraftChange,
  type DraftStage,
  type FeedbackItem,
  type FeedbackTarget,
  type IterationSummary,
  type ProposalView,
  type RevisePreview,
  type SentFailure,
} from '@ih/shared';

/** Pure helpers of the Revise tab (handoff §9). */

const DOT = '·';
const pct = (n: number) => `${Math.round(n * 100)}%`;
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) => new Date(iso).toLocaleDateString();

export const TARGET_TAG: Record<FeedbackTarget, string> = {
  field: 'FIELD',
  table: 'TABLE',
  step: 'STEP',
  section: 'SECTION',
};

/** Tab names of the drafting stages a banner may point at (the stage ids are the tab ids). */
export const STAGE_NAME: Partial<Record<DraftStage, string>> = {
  survey: 'Survey',
  outputs: 'Outputs',
  sections: 'Sections',
  steps: 'Steps',
};

type Def = Record<string, unknown>;
const obj = (v: unknown): Def =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Def) : {};
const idsOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => obj(x).id)
    .filter((id): id is string => typeof id === 'string' && FEEDBACK_TARGET_ID.test(id));

/** The ids the add form offers (handoff §9: filled from the draft), in definition order. */
export function feedbackTargetIds(definition: unknown, target: FeedbackTarget): string[] {
  const def = obj(definition);
  const outputs = obj(def.outputs);
  switch (target) {
    case 'field':
      return idsOf(outputs.fields);
    case 'table':
      return idsOf(outputs.tables);
    case 'step':
      return idsOf(def.pipeline);
    case 'section':
      return idsOf(obj(def.document).sections);
  }
}

const scalar = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Diff chips of one failing sample: `due_date`, `total 3,912.00 ≠ 4,694.40`, `line_items −1 row`. */
export function failureChips(f: SentFailure): string[] {
  const fields = f.fields.map((x) =>
    scalar(x.actual) && scalar(x.expected)
      ? `${x.id} ${String(x.actual)} ≠ ${String(x.expected)}`
      : x.id,
  );
  const tables = f.tables.flatMap((t) => {
    const cells = new Map<string, number>();
    for (const row of t.changed) {
      for (const col of row.columns) cells.set(col, (cells.get(col) ?? 0) + 1);
    }
    return [
      ...(t.missing ? [`${t.id} −${count(t.missing, 'row')}`] : []),
      ...(t.extra ? [`${t.id} +${count(t.extra, 'row')}`] : []),
      ...[...cells].map(([col, n]) => `${t.id}.${col} ${count(n, 'cell')}`),
    ];
  });
  return [...fields, ...tables];
}

/** The "What the model will see" summary line. */
export function previewSummary(p: RevisePreview): string {
  const each = `up to ${p.limits.fieldDiffs} fields and ${p.limits.rowDiffs} rows per table each`;
  const failures =
    p.failuresTotal > p.failures.length
      ? `${p.failures.length} of ${p.failuresTotal} failure diffs (the worst ${p.limits.samples}; ${each})`
      : `${count(p.failures.length, 'failure diff')} (${each})`;
  return [
    count(p.feedback.length, 'feedback item'),
    failures,
    p.draft ? `draft v${p.draft.version}` : 'no open draft',
    p.model ?? 'drafting model not set',
  ].join(` ${DOT} `);
}

/** "v4 · 12/10/2026 · 6 of 6 below 100%" (plus the model of a comparison member). */
export function failuresHeader(p: RevisePreview): string | null {
  const from = p.failuresFrom;
  if (!from) return null;
  return [
    `v${from.templateVersion}`,
    day(from.createdAt),
    `${p.failuresTotal} of ${from.compared} below 100%`,
    ...(from.model ? [from.model] : []),
  ].join(` ${DOT} `);
}

/** The violet footer (§0.3): what the holdout rule keeps out of the call. */
export function notSentText({ holdoutSamples, holdoutRun }: RevisePreview['notSent']): string {
  if (holdoutRun) {
    const score = holdoutRun.score === null ? '' : ` (${pct(holdoutRun.score)})`;
    return `Not sent: the holdout run${score} and its ${count(holdoutSamples, 'sample')}.`;
  }
  return holdoutSamples
    ? `Not sent: the ${count(holdoutSamples, 'holdout sample')}.`
    : 'Not sent: holdout samples (none yet).';
}

/** "From Evaluate · dev run v4 · date" or "Added here · date". */
export function feedbackOrigin(f: FeedbackItem, iterations: readonly IterationSummary[]): string {
  if (f.iterationId === null) return `Added here ${DOT} ${day(f.createdAt)}`;
  const run = iterations.find((i) => i.id === f.iterationId);
  return run
    ? `From Evaluate ${DOT} dev run v${run.templateVersion} ${DOT} ${day(run.createdAt)}`
    : `From Evaluate ${DOT} ${day(f.createdAt)}`;
}

/** Open feedback, plus what the latest revision answered (shown ANSWERED). */
export function shownFeedback(
  items: readonly FeedbackItem[],
  latest: ProposalView | null,
): FeedbackItem[] {
  return items.filter(
    (f) => f.resolvedBy === null || (latest !== null && f.resolvedBy === latest.id),
  );
}

/** The list numbers of the feedback a change answers (the "Answers ①" badge). */
export function answerNumbers(c: DraftChange, shown: readonly FeedbackItem[]): number[] {
  const at = new Map(shown.map((f, i) => [f.id, i + 1]));
  return (c.answers ?? []).flatMap((id) => (at.has(id) ? [at.get(id)!] : [])).sort((a, b) => a - b);
}

/** Proposals are listed newest first. */
export const latestRevise = (proposals: readonly ProposalView[]): ProposalView | null =>
  proposals.find((p) => p.stage === 'revise') ?? null;

/** The first drafting stage whose newest proposal is still waiting for a decision. */
export function openProposalStage(proposals: readonly ProposalView[]): DraftStage | null {
  return (
    STAGE_ORDER.find((stage) => proposals.find((p) => p.stage === stage)?.status === 'ready') ??
    null
  );
}

export interface EarlierRevision {
  id: string;
  createdAt: string;
  model: string | null;
  status: ProposalView['status'];
  applied: number;
  total: number;
  answered: number;
}

/** Every revise proposal before the latest (which the card shows), newest first. */
export function earlierRevisions(
  proposals: readonly ProposalView[],
  feedback: readonly FeedbackItem[],
): EarlierRevision[] {
  return proposals
    .filter((p) => p.stage === 'revise')
    .slice(1)
    .map((p) => ({
      id: p.id,
      createdAt: p.createdAt,
      model: p.model,
      status: p.status,
      applied: p.acceptedChanges?.length ?? 0,
      total: changeBodyOf(p)?.changes.length ?? 0,
      answered: feedback.filter((f) => f.resolvedBy === p.id).length,
    }));
}

const UNDECIDED: Partial<Record<ProposalView['status'], string>> = {
  ready: 'not decided',
  running: 'running',
  failed: 'failed',
};

export function revisionLine(r: EarlierRevision): string {
  const head = [day(r.createdAt), r.model ?? '—'];
  if (r.status === 'accepted' || r.status === 'partially_accepted') {
    return [
      ...head,
      `${r.applied} of ${r.total} applied`,
      `answered ${count(r.answered, 'feedback item')}`,
    ].join(` ${DOT} `);
  }
  if (r.status === 'rejected')
    return [...head, `rejected (${count(r.total, 'change')})`].join(` ${DOT} `);
  return [...head, UNDECIDED[r.status] ?? r.status].join(` ${DOT} `);
}
