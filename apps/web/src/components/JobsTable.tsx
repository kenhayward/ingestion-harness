import { useEffect, useRef, useState } from 'react';
import type { JobStatus, JobSummary } from '@ih/shared';
import type { Api } from '../api/client.js';

export function JobsTable({
  api,
  jobs,
  onChanged,
  retryModel = '',
}: {
  api: Api;
  jobs: JobSummary[];
  onChanged: () => void;
  /** Model selected in the upload form ('' = spec default); Retry runs with it. */
  retryModel?: string;
}) {
  if (jobs.length === 0) return <p>No jobs yet.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>File</th>
          <th>Spec</th>
          <th>Model</th>
          <th>Status</th>
          <th>Attempts</th>
          <th>Created</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <tr key={job.id}>
            <td>{job.filename}</td>
            <td>
              {job.specId} v{job.specVersion}
            </td>
            <td>{modelLabel(job)}</td>
            <td>
              <span className={`status status-${job.status}`}>{job.status}</span>
              {job.error && <div className="error">{job.error}</div>}
              {job.status === 'awaiting_review' &&
                job.reviewReasons?.map((r) => (
                  <div key={r} className="error">
                    {r}
                  </div>
                ))}
            </td>
            <td>{job.attempts}</td>
            <td>{new Date(job.createdAt).toLocaleString()}</td>
            <td>
              <JobActions api={api} job={job} onChanged={onChanged} retryModel={retryModel} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** What ran (step runs), else what was requested (override), else the spec default. */
function modelLabel(job: JobSummary): string {
  if (job.modelsUsed.length) return job.modelsUsed.join(', ');
  return job.modelOverride ?? 'Spec default';
}

const DELETABLE = new Set<JobStatus>([
  'succeeded',
  'failed',
  'needs_review',
  'rejected',
  'cancelled',
]);
/** awaiting_review: decide; succeeded: read-only view (evidence, edits, save as reference). */
const REVIEWABLE = new Set<JobStatus>(['awaiting_review', 'succeeded']);
type Action = 'cancel' | 'delete' | 're-run';

/** Inline confirmation text per action (also the Confirm button's description). */
const PROMPTS: Record<Action, (filename: string) => string> = {
  delete: (f) => `Delete ${f}? Published copies in the target are kept.`,
  cancel: () => 'Cancel job?',
  're-run': (f) =>
    `Re-run ${f}? It is extracted again on the latest template version; earlier review edits are discarded.`,
};

const RETRYABLE = new Set<JobStatus>(['failed', 'needs_review', 'cancelled']);

/** Row actions; Cancel and Delete ask for an inline confirmation first. */
function JobActions({
  api,
  job,
  onChanged,
  retryModel,
}: {
  api: Api;
  job: JobSummary;
  onChanged: () => void;
  retryModel: string;
}) {
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Keyboard/screen-reader users: focus the confirmation when it opens, and the button that
  // opened it when they keep the job.
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggers = useRef<Partial<Record<Action, HTMLButtonElement | null>>>({});
  const [returnFocus, setReturnFocus] = useState<Action | null>(null);
  useEffect(() => {
    if (confirm) confirmRef.current?.focus();
    else if (returnFocus) {
      triggers.current[returnFocus]?.focus();
      setReturnFocus(null);
    }
  }, [confirm, returnFocus]);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      setConfirm(null);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const alert = error && (
    <div role="alert" className="error">
      {error}
    </div>
  );

  if (confirm) {
    const promptId = `confirm-${job.id}`;
    return (
      <>
        <span id={promptId}>{PROMPTS[confirm](job.filename)}</span>{' '}
        <button
          ref={confirmRef}
          type="button"
          aria-label={`Confirm ${confirm} ${job.filename}`}
          aria-describedby={promptId}
          onClick={() =>
            void run(() =>
              confirm === 'delete'
                ? api.deleteJob(job.id)
                : confirm === 'cancel'
                  ? api.cancelJob(job.id)
                  : api.retryJob(job.id, retryModel || null),
            )
          }
        >
          Confirm
        </button>
        <button
          type="button"
          aria-label={`Keep ${job.filename}`}
          onClick={() => {
            setReturnFocus(confirm);
            setConfirm(null);
          }}
        >
          Keep
        </button>
        {alert}
      </>
    );
  }
  return (
    <>
      {REVIEWABLE.has(job.status) && <a href={`#/review/${job.id}`}>Review</a>}
      {RETRYABLE.has(job.status) && (
        <button
          type="button"
          onClick={() => void run(() => api.retryJob(job.id, retryModel || null))}
        >
          Retry with {retryModel || 'spec default'}
        </button>
      )}
      {job.status === 'succeeded' && (
        <button
          ref={(el) => {
            triggers.current['re-run'] = el;
          }}
          type="button"
          onClick={() => setConfirm('re-run')}
        >
          Re-run with {retryModel || 'spec default'}
        </button>
      )}
      {(job.status === 'queued' || job.status === 'running') && (
        <button
          ref={(el) => {
            triggers.current.cancel = el;
          }}
          type="button"
          onClick={() => setConfirm('cancel')}
        >
          Cancel
        </button>
      )}
      {DELETABLE.has(job.status) && (
        <button
          ref={(el) => {
            triggers.current.delete = el;
          }}
          type="button"
          className="danger"
          onClick={() => setConfirm('delete')}
        >
          Delete
        </button>
      )}
      {alert}
    </>
  );
}
