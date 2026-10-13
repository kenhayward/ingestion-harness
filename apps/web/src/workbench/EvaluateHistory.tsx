import { useId } from 'react';
import type { IterationSummary, IterationView, ModelChoice, Publication } from '@ih/shared';
import { PublicationsLog } from './GateCard.js';
import {
  accuracyLabel,
  accuracyList,
  accuracyTone,
  historyBars,
  historyRows,
  historySummary,
} from './evaluate.js';
import { SampleTag } from './tags.js';

const DOT = '·';
const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);

/** Accuracy by output (handoff §8): worst first, red < 70 %, amber < threshold, green ≥ it. */
export function AccuracyCard({
  iteration,
  threshold,
}: {
  iteration: IterationView;
  threshold: number;
}) {
  const titleId = useId();
  const { rows, more, perfect } = accuracyList(iteration.scorecard);
  return (
    <section className="card eval-accuracy" aria-labelledby={titleId}>
      <header className="eval-card-head">
        <h3 id={titleId}>Accuracy by output</h3>
        <span className="muted">
          {iteration.set} run {DOT} worst first
        </span>
      </header>
      {rows.length === 0 ? (
        <p className={perfect ? undefined : 'muted'}>
          {perfect ? 'Every output and column is at 100%.' : 'Nothing compared yet.'}
        </p>
      ) : (
        <ul className="acc-list" aria-label="Accuracy by output">
          {rows.map((a) => (
            <li key={a.id} className="acc-row" data-tone={accuracyTone(a.accuracy, threshold)}>
              <code className="acc-id">{a.id}</code>
              <span className="acc-bar" role="img" aria-label={accuracyLabel(a, threshold)}>
                <span className="acc-fill" style={{ width: `${Math.round(a.accuracy * 100)}%` }} />
              </span>
              <span className="acc-figure">
                {pct(a.accuracy)} {DOT} {a.matched} / {a.total}
              </span>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className="muted">+ {more} more below 100%</p>}
      {perfect > 0 && rows.length > 0 && <p className="muted">+ {perfect} more at 100%</p>}
    </section>
  );
}

/** History (handoff §8): the template-model chart, every evaluation with Restore, publications. */
export function HistoryCard({
  history,
  version,
  threshold,
  busy,
  onRestore,
  publications,
  choices,
}: {
  choices: readonly ModelChoice[];
  history: IterationSummary[];
  /** The draft (or, without one, the published) version: other versions' bars are dimmed. */
  version: number | null;
  threshold: number;
  busy: boolean;
  onRestore: (iterationId: string) => void;
  publications: Publication[];
}) {
  const titleId = useId();
  const bars = historyBars(history, version);
  const rows = historyRows(history, choices);
  return (
    <section className="card eval-history" aria-labelledby={titleId}>
      <header className="eval-card-head">
        <h3 id={titleId}>History</h3>
        <span className="eval-legend" aria-hidden="true">
          <span className="legend-dev">Dev</span>
          <span className="legend-holdout">Holdout</span>
        </span>
      </header>
      {bars.length > 0 && (
        <figure className="eval-chart">
          <div className="eval-bars" role="img" aria-label={historySummary(bars, threshold)}>
            <span className="eval-threshold" style={{ bottom: `${threshold * 100}%` }}>
              <span className="eval-threshold-label" aria-hidden="true">
                {pct(threshold)}
              </span>
            </span>
            {bars.map((b) => (
              <span
                key={b.id}
                className={`eval-bar ${b.set}${b.dimmed ? ' dimmed' : ''}`}
                style={{ height: `${Math.max(2, b.score * 100)}%` }}
              />
            ))}
          </div>
          <div className="eval-bar-labels" aria-hidden="true">
            {bars.map((b) => (
              <span key={b.id}>
                v{b.version} {b.set === 'dev' ? 'D' : 'H'}
              </span>
            ))}
          </div>
        </figure>
      )}
      {rows.length === 0 ? (
        <p className="muted">No evaluations yet.</p>
      ) : (
        <ul className="eval-history-list" aria-label="Evaluations">
          {rows.map((r) => (
            <li key={r.id} className="eval-history-row">
              <strong>v{r.version}</strong>
              <span className="eval-history-what">
                <SampleTag role={r.set} /> {r.label}
                <small className="muted">{new Date(r.createdAt).toLocaleString()}</small>
              </span>
              <span className="eval-history-score">{r.running ? 'running' : pct(r.score)}</span>
              <button
                type="button"
                disabled={busy}
                title={busy ? 'Working…' : 'Replaces the open draft'}
                aria-label={`Restore v${r.version} ${r.set} run of ${new Date(r.createdAt).toLocaleString()}`}
                onClick={() => onRestore(r.id)}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      <PublicationsLog publications={publications} />
    </section>
  );
}
