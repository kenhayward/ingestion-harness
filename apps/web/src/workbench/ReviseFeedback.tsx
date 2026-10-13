import { useId, useState } from 'react';
import {
  FEEDBACK_MAX_CHARS,
  FEEDBACK_TARGETS,
  type FeedbackItem,
  type FeedbackTarget,
  type IterationSummary,
  type SampleView,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { Segmented } from '../ui/Segmented.js';
import { feedbackOrigin, feedbackTargetIds, TARGET_TAG } from './revise.js';

const TARGET_LABEL: Record<FeedbackTarget, string> = {
  field: 'Field',
  table: 'Table',
  step: 'Step',
  section: 'Section',
};
const TARGET_TONE: Record<FeedbackTarget, string> = {
  field: 'info',
  table: 'ok',
  step: 'warn',
  section: 'skip',
};

/**
 * "Your feedback" (handoff §9): numbered items with target, sample, body and origin; answered
 * items are tagged and kept; the add form's id list comes from the draft. Holdout rule (RV3):
 * the form never sends a sample or a run (feedback from a run is added on the Evaluate tab).
 */
export function ReviseFeedback({
  api,
  projectId,
  items,
  notSent,
  samples,
  iterations,
  definition,
  onChanged,
}: {
  api: Api;
  projectId: string;
  /** Open feedback and what the latest revision answered (`shownFeedback`). */
  items: FeedbackItem[];
  /** Open feedback the next revision does not send (its sample is no longer a ready dev sample). */
  notSent: FeedbackItem[];
  samples: SampleView[];
  iterations: IterationSummary[];
  /** The open draft (ids for the add form); null without one. */
  definition: unknown;
  onChanged: () => void;
}) {
  const headingId = useId();
  const heldId = useId();
  const [target, setTarget] = useState<FeedbackTarget>('field');
  const [chosen, setChosen] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = feedbackTargetIds(definition, target);
  const targetId = options.includes(chosen) ? chosen : (options[0] ?? '');
  const open = items.filter((f) => f.resolvedBy === null).length;
  const sampleName = (id: string) => samples.find((s) => s.id === id)?.filename ?? null;
  const addReason =
    definition === null
      ? 'Start the next version on the Template tab first'
      : !targetId
        ? `The draft has no ${target}s yet`
        : !body.trim()
          ? 'Write the feedback first'
          : null;

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
  const add = () =>
    act(async () => {
      await api.addFeedback(projectId, { target, targetId, body: body.trim() });
      setBody('');
      onChanged();
    });
  const remove = (id: string) =>
    act(async () => {
      await api.deleteFeedback(projectId, id);
      onChanged();
    });

  return (
    <section className="revise-feedback" aria-labelledby={headingId}>
      <h3 id={headingId}>
        Your feedback <span className="muted">{open} open</span>
      </h3>
      {items.length === 0 ? (
        <p className="muted">
          No open feedback. Add a note below, or comment on a dev run on the Evaluate tab.
        </p>
      ) : (
        <ol className="feedback-list">
          {items.map((f, i) => {
            const answered = f.resolvedBy !== null;
            const sample = f.sampleId ? sampleName(f.sampleId) : null;
            return (
              <li key={f.id} className="feedback-item">
                <span className="feedback-num" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="feedback-text">
                  <p className="feedback-head">
                    <span className={`kind-tag tone-${TARGET_TONE[f.target]}`}>
                      {TARGET_TAG[f.target]}
                    </span>{' '}
                    <code>{f.targetId}</code>
                    {sample && <span className="muted"> · {sample}</span>}
                    {answered && (
                      <>
                        {' '}
                        <span className="kind-tag tone-ok">ANSWERED</span>
                      </>
                    )}
                  </p>
                  <p className="feedback-body">{f.body}</p>
                  <p className="muted feedback-origin">{feedbackOrigin(f, iterations)}</p>
                </div>
                {!answered && (
                  <button
                    type="button"
                    aria-label={`Delete feedback ${i + 1}`}
                    disabled={busy}
                    onClick={() => void remove(f.id)}
                  >
                    Delete
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {notSent.length > 0 && (
        <section className="feedback-held" aria-labelledby={heldId}>
          <h4 id={heldId}>Not sent</h4>
          <p className="muted">
            Its sample is no longer a ready dev sample, so the model does not see it.
          </p>
          <ul>
            {notSent.map((f) => (
              <li key={f.id} className="feedback-item">
                <div className="feedback-text">
                  <p className="feedback-head">
                    <span className={`kind-tag tone-${TARGET_TONE[f.target]}`}>
                      {TARGET_TAG[f.target]}
                    </span>{' '}
                    <code>{f.targetId}</code>
                  </p>
                  <p className="feedback-body">{f.body}</p>
                </div>
                <button
                  type="button"
                  aria-label={`Delete feedback not sent: ${f.targetId}`}
                  disabled={busy}
                  onClick={() => void remove(f.id)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <form
        className="feedback-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <div className="feedback-add-row">
          <Segmented
            label="Add feedback about"
            options={FEEDBACK_TARGETS.map((t) => ({ value: t, label: TARGET_LABEL[t] }))}
            value={target}
            onChange={(t) => {
              setTarget(t);
              setChosen('');
            }}
          />
          <select
            aria-label="Id"
            value={targetId}
            disabled={!options.length}
            onChange={(e) => setChosen(e.target.value)}
          >
            {options.length ? (
              options.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))
            ) : (
              <option value="">No {target}s in the draft</option>
            )}
          </select>
        </div>
        <div className="feedback-add-row">
          <textarea
            aria-label="Feedback"
            placeholder="What should change, in plain words"
            maxLength={FEEDBACK_MAX_CHARS}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy || addReason !== null}
            title={addReason ?? undefined}
          >
            Add
          </button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
