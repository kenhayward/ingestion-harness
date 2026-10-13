import type { StepProgress, TestRun } from '@ih/shared';
import { StatusPill } from '../ui/StatusPill.js';
import {
  batchSegments,
  progressText,
  runAction,
  runDetail,
  runDuration,
  segmentsText,
  type RunBatch,
} from './runs.js';

/** A running step as segments, one per extract step (done, current, to do). */
function StepBar({ progress }: { progress: StepProgress }) {
  return (
    <span className="runs-stepbar" role="img" aria-label={progressText(progress)}>
      {Array.from({ length: progress.of }, (_, i) => (
        <span
          key={i}
          className={
            i + 1 < progress.index ? 'is-done' : i + 1 === progress.index ? 'is-current' : ''
          }
        />
      ))}
    </span>
  );
}

/** One run per row: file, status, detail (with step progress), duration, Review or Retry. */
export function RunRows({
  runs,
  now,
  onRetry,
}: {
  runs: readonly TestRun[];
  now: number;
  onRetry: (run: TestRun) => void;
}) {
  return (
    <>
      {runs.map((run) => {
        const detail = runDetail(run);
        const action = runAction(run);
        return (
          <tr key={run.id}>
            <td>
              <code className="runs-file">{run.filename}</code>
            </td>
            <td>
              <StatusPill status={run.status} />
            </td>
            <td>
              <span className={`runs-detail tone-text-${detail.tone}`}>{detail.text}</span>
              {run.status === 'running' && run.progress && <StepBar progress={run.progress} />}
            </td>
            <td className="runs-duration">{runDuration(run, now)}</td>
            <td className="runs-action">
              {action === 'review-now' && (
                <a className="runs-review-now" href={`#/review/${run.id}`}>
                  Review now
                </a>
              )}
              {action === 'review' && <a href={`#/review/${run.id}`}>Review</a>}
              {action === 'retry' && (
                <button
                  type="button"
                  aria-label={`Retry ${run.filename}`}
                  onClick={() => onRetry(run)}
                >
                  Retry
                </button>
              )}
            </td>
          </tr>
        );
      })}
    </>
  );
}

/** Column heads shared by the batch tables. */
export function RunHead() {
  return (
    <thead>
      <tr>
        <th scope="col">File</th>
        <th scope="col">Status</th>
        <th scope="col">Detail</th>
        <th scope="col" className="runs-duration">
          Duration
        </th>
        <th scope="col">
          <span className="visually-hidden">Action</span>
        </th>
      </tr>
    </thead>
  );
}

/** One batch of test runs (handoff §11): header with a stacked status bar, then its rows. */
export function RunBatchCard({
  batch,
  title,
  subtitle,
  now,
  onRetry,
}: {
  batch: RunBatch;
  title: string;
  subtitle: string;
  now: number;
  onRetry: (run: TestRun) => void;
}) {
  const segments = batchSegments(batch);
  const summary = segmentsText(segments);
  return (
    <section className={`card runs-batch${batch.active ? ' is-live' : ''}`} aria-label={title}>
      <header className="runs-batch-head">
        <div className="runs-batch-title">
          <h3>{title}</h3>
          <p className="muted">{subtitle}</p>
        </div>
        <div className="runs-batch-status">
          <span className="runs-stack" role="img" aria-label={`Batch status: ${summary}`}>
            {segments.map((s) => (
              <span
                key={s.status}
                className="runs-stack-seg"
                style={{ flexGrow: s.count, background: `var(--ih-${s.tone}-fg)` }}
              />
            ))}
          </span>
          <span className="runs-stack-legend muted">{summary}</span>
        </div>
      </header>
      <div className="table-scroll">
        <table className="runs-table" aria-label={`Runs of ${title}`}>
          <RunHead />
          <tbody>
            <RunRows runs={batch.runs} now={now} onRetry={onRetry} />
          </tbody>
        </table>
      </div>
    </section>
  );
}
