import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  applyChanges,
  changeBodyOf,
  outputChanges,
  type DataPolicy,
  type DraftChange,
  type FeedbackItem,
  type IterationSummary,
  type ProposalView,
  type RevisePreview,
  type SampleView,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { ModelLogButton } from './DraftLogDialog.js';
import { useModelChoices } from '../ui/ModelPicker.js';
import { ReprocessDialog } from '../ui/ReprocessDialog.js';
import {
  evaluateBlocker,
  referenceCounts,
  runningEvaluation,
  type ReferenceCounts,
} from './evaluate.js';
import { DraftRunProgress } from './DraftRunProgress.js';
import { ProposalCard, type NextStep } from './ProposalCard.js';
import { ReviseFeedback } from './ReviseFeedback.js';
import {
  answerNumbers,
  earlierRevisions,
  failureChips,
  diagnosticLines,
  failuresHeader,
  latestRevise,
  notSentText,
  openProposalStage,
  previewSummary,
  revisionLine,
  sentFeedback,
  shownFeedback,
  STAGE_NAME,
} from './revise.js';
import { POLICY_NOTE } from './StagePanel.js';
import { StaleBanner } from './StaleBanner.js';

const pct = (n: number) => `${Math.round(n * 100)}%`;

const NEXT = (projectId: string, action: NextStep['action']): NextStep => ({
  href: `#/workbench/${projectId}/evaluate`,
  label: 'Evaluate on dev',
  text: 'Run the dev set to see whether the changes helped; when dev looks right, run holdout to check the gate.',
  action,
});

/** Output keys the chosen changes would add, remove or reshape (outdating their references). */
function outputsChangedBy(definition: unknown, changes: DraftChange[]): string[] {
  if (!definition || typeof definition !== 'object' || !changes.length) return [];
  try {
    const before = definition as Record<string, unknown>;
    return outputChanges(before.outputs ?? {}, applyChanges(before, changes).outputs ?? {});
  } catch {
    return []; // a change that no longer applies is refused on Apply, with its reason
  }
}

function AnswersBadge({ numbers }: { numbers: number[] }) {
  return (
    <span className="answers-badge">
      Answers
      {numbers.map((n) => (
        <Fragment key={n}>
          {' '}
          <span className="answer-num">{n}</span>
        </Fragment>
      ))}
    </span>
  );
}

interface Loaded {
  preview: RevisePreview;
  feedback: FeedbackItem[];
  proposals: ProposalView[];
  samples: SampleView[];
  iterations: IterationSummary[];
  /** Dev references (undefined when unreadable: the API decides then). */
  refs: ReferenceCounts | undefined;
}

/**
 * Revise (handoff §9, RV1–RV3): what the next revision sends (preview), your feedback, the
 * latest dev failures, the proposal with the feedback each change answers, earlier revisions.
 */
export function ReviseTab({
  api,
  projectId,
  dataPolicy,
  draft,
  pollMs,
  retired = null,
  onApplied,
  onChanged,
  now = Date.now(),
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  draft: number | null;
  pollMs: number;
  /** Why job-creating actions are off (a retired document type); null when they are not. */
  retired?: string | null;
  onApplied: () => void;
  /** Something the overview shows changed (feedback, a revision asked, rejected or ready). */
  onChanged: () => void;
  now?: number;
}) {
  const models = useModelChoices(api);
  const seeId = useId();
  const failId = useId();
  const diagId = useId();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const seq = useRef(0);
  const inFlight = useRef(false);
  const lastStatus = useRef<string | null>(null);

  const load = useCallback(async () => {
    const id = ++seq.current;
    inFlight.current = true;
    try {
      const [preview, feedback, proposals, samples, iterations, refs] = await Promise.all([
        api.getRevisePreview(projectId),
        api.listFeedback(projectId),
        api.listProposals(projectId),
        api.listSamples(projectId),
        api.listIterations(projectId),
        api.listReferenceRows(projectId, 'dev').then(referenceCounts, () => undefined),
      ]);
      if (id !== seq.current) return; // a newer load (or unmount) superseded this one
      setData({ preview, feedback, proposals, samples, iterations, refs });
      setError(null);
    } catch (err) {
      if (id === seq.current) setError((err as Error).message);
    } finally {
      if (id === seq.current) inFlight.current = false;
    }
  }, [api, projectId]);

  useEffect(() => {
    void load();
    const counter = seq; // the counter object itself, not a rendered node
    return () => {
      counter.current++;
    };
  }, [load, draft]);

  const latest = data ? latestRevise(data.proposals) : null;
  const running = latest?.status === 'running';
  /** The open draft's version: what an evaluation started here runs. */
  const draftVersion = data?.preview.draft?.version ?? draft;
  /** A dev evaluation of the draft still going (started here or on Evaluate). */
  const evaluating = data ? runningEvaluation(data.iterations, draftVersion, 'dev') : null;
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!running && !evaluating) return;
    const timer = setInterval(() => {
      if (!inFlight.current) void load();
    }, pollMs);
    return () => clearInterval(timer);
  }, [running, evaluating, pollMs, load]);

  // The page learns when an evaluation followed here finishes (the overview's Next moves on).
  const evaluatingId = evaluating?.id ?? null;
  const lastEvaluating = useRef<string | null>(null);
  useEffect(() => {
    if (lastEvaluating.current !== null && evaluatingId === null) onChanged();
    lastEvaluating.current = evaluatingId;
  }, [evaluatingId, onChanged]);

  // The page learns when a running revision finishes (its rail and header show the stage).
  const status = latest?.status ?? null;
  useEffect(() => {
    if (lastStatus.current === 'running' && status !== 'running') onChanged();
    lastStatus.current = status;
  }, [status, onChanged]);

  // A new proposal starts with every change selected (reset during render, as StagePanel does).
  const body = latest ? changeBodyOf(latest) : null;
  const changeCount = body?.changes.length ?? 0;
  const selectionKey = `${latest?.id ?? ''}:${changeCount}`;
  const [selectedFor, setSelectedFor] = useState(selectionKey);
  if (selectedFor !== selectionKey) {
    setSelectedFor(selectionKey);
    setSelected(new Set(Array.from({ length: changeCount }, (_, i) => i)));
  }

  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ask = () =>
    act(async () => {
      await api.startStage(projectId, 'revise');
      onChanged();
      await load();
    });
  const apply = () =>
    act(async () => {
      if (!latest) return;
      await api.decideProposal(
        projectId,
        latest.id,
        'accepted',
        [...selected].sort((a, b) => a - b),
      );
      onApplied();
      await load();
    });
  const reject = () =>
    act(async () => {
      if (!latest) return;
      await api.decideProposal(projectId, latest.id, 'rejected');
      onChanged();
      await load();
    });
  const toggle = (i: number) => {
    const next = new Set(selected);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setSelected(next);
  };

  if (!data) {
    return error ? (
      <div>
        <p role="alert">{error}</p>
        <button type="button" onClick={() => void load()}>
          Retry
        </button>
      </div>
    ) : (
      <p>Loading…</p>
    );
  }

  const { preview } = data;
  const { sent: shown, notSent: heldBack } = sentFeedback(
    shownFeedback(data.feedback, latest),
    preview,
  );
  const other = openProposalStage(data.proposals);
  const header = failuresHeader(preview, models);
  const earlier = earlierRevisions(data.proposals, data.feedback);
  const askReason =
    retired ??
    (!preview.draft
      ? 'Start the next version on the Recipe tab first'
      : running
        ? 'A revision is being drafted'
        : !preview.feedback.length && !preview.diagnostics
          ? 'Add feedback or run the dev samples first: a revision answers your feedback and what the runs showed.'
          : preview.model === null
            ? 'Set the drafting model under Administration > Models first'
            : null);
  const evaluateBlocked = evaluateBlocker({
    retired,
    draft: draftVersion,
    set: 'dev',
    refs: data.refs,
    history: data.iterations,
    comparing: false,
    busy,
  });
  const outdatedBlock =
    data.refs !== undefined && data.refs.verified === 0 && data.refs.outdated > 0;
  const evaluateButton = (
    <button
      type="button"
      className="primary"
      disabled={evaluateBlocked !== null}
      title={evaluateBlocked ?? undefined}
      onClick={() => setAsking(true)}
    >
      Evaluate v{draftVersion} on dev…
    </button>
  );
  /** The applied card offers Evaluate itself: one button on the page is enough. */
  const cardOffers =
    body !== null && (latest?.status === 'accepted' || latest?.status === 'partially_accepted');
  /** What the chosen changes do to outputs, said before they are applied. */
  const reshaped =
    latest?.status === 'ready' && body
      ? outputsChangedBy(
          preview.draft?.definition,
          body.changes.filter((_, i) => selected.has(i)),
        )
      : [];
  const badge = (c: DraftChange) => {
    const numbers = answerNumbers(c, shown);
    return numbers.length ? <AnswersBadge numbers={numbers} /> : null;
  };

  return (
    <div className="revise-tab">
      <p className="muted">{POLICY_NOTE[dataPolicy]}</p>
      {other && (
        <StaleBanner tone="warn">
          <strong>{STAGE_NAME[other]} has an open proposal.</strong> Decide it first so this
          revision does not spend itself proposing the same fix.{' '}
          <a href={`#/workbench/${projectId}/${other}`}>Open {STAGE_NAME[other]}</a>
        </StaleBanner>
      )}
      {error && <p role="alert">{error}</p>}
      <section className="card revise-see" aria-labelledby={seeId}>
        <div className="revise-see-head">
          <div className="revise-see-text">
            <h3 id={seeId}>What the model will see</h3>
            <p className="muted">{previewSummary(preview, models)}</p>
          </div>
          <button
            type="button"
            className="primary"
            disabled={busy || askReason !== null}
            title={askReason ?? undefined}
            onClick={() => void ask()}
          >
            Ask the model for a revision
          </button>
        </div>
        <div className="revise-split">
          <ReviseFeedback
            api={api}
            projectId={projectId}
            items={shown}
            notSent={heldBack}
            samples={data.samples}
            iterations={data.iterations}
            definition={preview.draft?.definition ?? null}
            onChanged={() => {
              void load();
              onChanged();
            }}
          />
          <section className="revise-failures" aria-labelledby={failId}>
            <h3 id={failId}>
              Failures from the latest dev run
              {header && <span className="muted"> {header}</span>}
            </h3>
            {preview.failuresFrom === null ? (
              <p className="muted revise-no-run">
                <span>No complete dev run yet. Evaluate on dev to send its failures.</span>{' '}
                {draftVersion !== null && !cardOffers && evaluateButton}
              </p>
            ) : preview.failures.length === 0 ? (
              <p className="muted">Every dev sample scored 100%.</p>
            ) : (
              <ul className="failure-list">
                {preview.failures.map((f, i) => (
                  <li key={`${i}-${f.sample}`}>
                    <span className="failure-head">
                      <code>{f.sample}</code>
                      <span>{pct(f.score)}</span>
                    </span>
                    <span className="failure-chips">
                      {failureChips(f).map((chip, j) => (
                        <code key={`${j}-${chip}`} className="diff-chip">
                          {chip}
                        </code>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {preview.failuresTotal > preview.failures.length && (
              <p className="muted">
                {preview.failuresTotal - preview.failures.length} more failing dev samples are not
                sent (the worst {preview.limits.samples} are).
              </p>
            )}
            <section className="revise-diagnostics" aria-labelledby={diagId}>
              <h3 id={diagId}>Run diagnostics</h3>
              {preview.diagnostics ? (
                <ul className="failure-list">
                  {diagnosticLines(preview.diagnostics).map((line, i) => (
                    <li key={`${i}-${line}`}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Run the dev samples to add what they show.</p>
              )}
            </section>
            <p className="holdout-note revise-not-sent">{notSentText(preview.notSent)}</p>
          </section>
        </div>
      </section>
      {running && latest && (
        <DraftRunProgress
          onCancel={() =>
            void act(async () => {
              await api.cancelProposal(projectId, latest.id);
              await load();
              onChanged();
            })
          }
          cancelling={busy}
          stage="revise"
          run={latest.run}
          label="Revision progress"
          fallback={
            <p role="status" className="revise-running">
              The model is drafting a revision…
            </p>
          }
        />
      )}
      {evaluating && (
        <p role="status" aria-label="Dev evaluation" className="revise-running">
          Evaluating v{evaluating.templateVersion} on dev · {evaluating.completed} of{' '}
          {evaluating.total} samples <a href={`#/workbench/${projectId}/evaluate`}>Open Evaluate</a>
        </p>
      )}
      {outdatedBlock && evaluateBlocked && (
        <p role="note" aria-label="Why Evaluate is off" className="eval-runbar-why">
          {evaluateBlocked}. <a href={`#/workbench/${projectId}/references`}>Open References</a>
        </p>
      )}
      {latest?.status === 'failed' && (
        <p role="alert">
          {latest.error} <ModelLogButton api={api} projectId={projectId} proposalId={latest.id} />
        </p>
      )}
      {latest && body && (
        <ProposalCard
          api={api}
          models={models}
          projectId={projectId}
          proposal={latest}
          body={body}
          definition={preview.draft?.definition ?? null}
          draftVersion={preview.draft?.version ?? draft}
          selected={selected}
          onToggle={toggle}
          onApply={() => void apply()}
          onReject={() => void reject()}
          busy={busy}
          now={now}
          next={NEXT(projectId, draftVersion === null ? undefined : evaluateButton)}
          badge={badge}
          footerNote={[
            reshaped.length
              ? `Changes outputs (${reshaped.join(', ')}): references verified before must be verified again before you can evaluate.`
              : null,
            'Feedback a change answers is marked answered when you apply it.',
          ]
            .filter(Boolean)
            .join(' ')}
        />
      )}
      {asking && draftVersion !== null && (
        <ReprocessDialog
          title={`Evaluate v${draftVersion} on dev`}
          confirmLabel="Evaluate"
          choices={models}
          emptyLabel="Document type's model"
          dataPolicy={dataPolicy}
          summary={
            <p>
              Runs v{draftVersion} on every verified dev reference and scores it, so the next
              revision is sent its failures.
            </p>
          }
          onConfirm={async (model) => {
            await api.startEvaluation(projectId, model, { uncached: false, set: 'dev' });
            onChanged();
            await load();
          }}
          onClose={() => setAsking(false)}
        />
      )}
      {earlier.length > 0 && (
        <details className="card revise-earlier">
          <summary>Earlier revisions · {earlier.length}</summary>
          <ul>
            {earlier.map((r) => (
              <li key={r.id}>{revisionLine(r, models)}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
