import { Fragment, useEffect, useState } from 'react';
import {
  FEEDBACK_MAX_CHARS,
  type EvaluationSet,
  type IterationView,
  type ModelChoice,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { choiceName } from '../jobs/derive.js';
import { Meter } from '../ui/Meter.js';
import { offOutputs, outputsDiffering, tableDiff } from './evaluate.js';

const DOT = '·';
const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);
const show = (v: unknown) =>
  v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v);

const EMPTY: Record<EvaluationSet, string> = {
  dev: 'No dev run yet. Evaluate the draft on dev to score it against the verified dev references.',
  holdout:
    'No holdout run yet. Holdout runs need verified holdout references (References tab) and are optional.',
};

export const SEALED_NOTE =
  'Holdout is sealed: you can see the differences, but comments are off so nothing from it reaches the model in Revise.';

type Target = { target: 'field' | 'table'; id: string };

function Verdict({ match }: { match: boolean }) {
  return match ? (
    <span role="img" aria-label="matches" className="eval-ok">
      ✓
    </span>
  ) : (
    <span role="img" aria-label="differs" className="eval-bad">
      ✗
    </span>
  );
}

/** The newest run of the selected set (handoff §8): rows, the comparison table, dev comments. */
export function LatestRun({
  api,
  projectId,
  iteration,
  set,
  threshold,
  choices,
}: {
  /** The model choices: the run's model shows by its label. */
  choices: readonly ModelChoice[];
  api: Api;
  projectId: string;
  iteration: IterationView | null;
  set: EvaluationSet;
  threshold: number;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [commenting, setCommenting] = useState<Target | null>(null);
  const [body, setBody] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iterationId = iteration?.id;
  useEffect(() => {
    setOpen(null);
    setCommenting(null);
    setSaved(false);
  }, [iterationId]);

  if (!iteration) {
    return (
      <section className="card eval-latest" aria-label="Latest run">
        <h3>Latest {set} run</h3>
        <p className="muted">{EMPTY[set]}</p>
      </section>
    );
  }
  const holdout = iteration.set === 'holdout';
  const opened = iteration.samples.find((s) => s.jobId !== null && s.jobId === open) ?? null;
  const comparison = opened?.comparison ?? null;

  const save = async () => {
    if (!commenting || !opened || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.addFeedback(projectId, {
        target: commenting.target,
        targetId: commenting.id,
        body,
        ...(opened.sampleId ? { sampleId: opened.sampleId } : {}),
        iterationId: iteration.id,
      });
      setCommenting(null);
      setBody('');
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const commentCell = (t: Target, match: boolean) =>
    !holdout && (
      <td>
        {!match && (
          <button
            type="button"
            onClick={() => {
              setCommenting(t);
              setBody('');
              setSaved(false);
              setError(null);
            }}
          >
            Comment
          </button>
        )}
      </td>
    );
  const commentRow = (t: Target) =>
    commenting?.target === t.target &&
    commenting.id === t.id && (
      <tr className="eval-comment-row">
        <td colSpan={5}>
          <label>
            Comment on {t.id} — goes to Revise as feedback for the model
            <textarea
              value={body}
              maxLength={FEEDBACK_MAX_CHARS}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !body.trim()}
              title={!body.trim() ? 'Write a comment first' : busy ? 'Saving…' : undefined}
              onClick={() => void save()}
            >
              Save comment
            </button>
            <button type="button" onClick={() => setCommenting(null)}>
              Cancel
            </button>
          </div>
        </td>
      </tr>
    );

  const differing = comparison ? outputsDiffering(comparison) : null;
  return (
    <section className="card eval-latest" aria-label="Latest run">
      <header className="eval-latest-head">
        <h3>
          Latest {iteration.set} run {DOT} v{iteration.templateVersion} {DOT}{' '}
          {iteration.model === null ? "recipe's models" : choiceName(iteration.model, choices)}
          {iteration.uncached && ` ${DOT} fresh`}
        </h3>
        <p className="muted">
          {new Date(iteration.createdAt).toLocaleString()} {DOT} {iteration.completed} of{' '}
          {iteration.total} compared
          {iteration.cache.total > 0 &&
            ` ${DOT} ${iteration.cache.reused} of ${iteration.cache.total} steps reused from the cache`}
          {iteration.status === 'running' && ` ${DOT} running`}
        </p>
      </header>
      <ul className="eval-samples" aria-label="Samples">
        {iteration.samples.map((s, i) => {
          const selectable = s.comparison !== null && s.jobId !== null;
          const status = s.status ? s.status.replace('_', ' ') : 'deleted';
          const off = s.comparison ? offOutputs(s.comparison) : [];
          const score = s.comparison?.score ?? null;
          return (
            <li key={`${i}-${s.jobId ?? s.filename}`}>
              <button
                type="button"
                className="eval-sample"
                aria-pressed={selectable && open === s.jobId}
                disabled={!selectable}
                title={
                  selectable
                    ? undefined
                    : `Not compared: ${status}${s.error ? ` (${s.error})` : ''}`
                }
                onClick={() => setOpen(open === s.jobId ? null : s.jobId)}
              >
                <code className="eval-file">{s.filename}</code>
                <Meter
                  label={`${s.filename} score`}
                  value={score}
                  min={0.7}
                  threshold={threshold}
                  tone={holdout ? 'skip' : 'accent'}
                />
                <span
                  className="eval-score"
                  data-tone={score === null ? undefined : score >= threshold ? 'ok' : 'warn'}
                >
                  {pct(score)}
                </span>
                <span className="eval-off">
                  {!s.comparison ? status : off.length ? `Off: ${off.join(', ')}` : 'All match'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {opened && comparison && differing && (
        <div className="eval-detail">
          <div className="eval-detail-head">
            <p>
              <code className="eval-file">{opened.filename}</code> {pct(comparison.score)} {DOT}{' '}
              {differing.differ} of {differing.of} outputs differ from the reference
            </p>
            {opened.jobId && <a href={`#/review/${opened.jobId}`}>Open in Review</a>}
          </div>
          {holdout && <p className="holdout-note">{SEALED_NOTE}</p>}
          <div className="table-scroll">
            <table aria-label={`Outputs in ${opened.filename}`}>
              <thead>
                <tr>
                  <th scope="col">Output</th>
                  <th scope="col">Reference</th>
                  <th scope="col">This run</th>
                  <th scope="col">Match</th>
                  {!holdout && (
                    <th scope="col">
                      <span className="visually-hidden">Comment</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {comparison.fields.map((f) => (
                  <Fragment key={`f-${f.id}`}>
                    <tr>
                      <td>
                        <code>{f.id}</code>
                      </td>
                      <td>{show(f.expected) ?? '—'}</td>
                      <td className={f.match ? undefined : 'eval-miss'}>
                        {show(f.actual) ?? '— empty'}
                      </td>
                      <td>
                        <Verdict match={f.match} />
                      </td>
                      {commentCell({ target: 'field', id: f.id }, f.match)}
                    </tr>
                    {commentRow({ target: 'field', id: f.id })}
                  </Fragment>
                ))}
                {comparison.tables.map((t) => {
                  const match = !t.missing.length && !t.extra.length && !t.changed.length;
                  return (
                    <Fragment key={`t-${t.id}`}>
                      <tr>
                        <td>
                          <code>{t.id}</code>
                        </td>
                        <td>
                          {t.expected} row{t.expected === 1 ? '' : 's'}
                        </td>
                        <td className={match ? undefined : 'eval-miss'}>{tableDiff(t)}</td>
                        <td>
                          <Verdict match={match} />
                        </td>
                        {commentCell({ target: 'table', id: t.id }, match)}
                      </tr>
                      {commentRow({ target: 'table', id: t.id })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {saved && (
        <p role="status">
          Comment saved — see <a href={`#/workbench/${projectId}/revise`}>Revise</a>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
