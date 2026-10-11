import { useState } from 'react';
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
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    return (
      <>
        <span>
          {confirm === 'delete'
            ? `Delete ${job.filename}? Published copies in the target are kept.`
            : 'Cancel job?'}
        </span>{' '}
        <button
          type="button"
          onClick={() =>
            void run(() => (confirm === 'delete' ? api.deleteJob(job.id) : api.cancelJob(job.id)))
          }
        >
          Confirm
        </button>
        <button type="button" onClick={() => setConfirm(null)}>
          Keep
        </button>
        {alert}
      </>
    );
  }
  return (
    <>
      {job.status === 'awaiting_review' && <a href={`#/review/${job.id}`}>Review</a>}
      {RETRYABLE.has(job.status) && (
        <button
          type="button"
          onClick={() => void run(() => api.retryJob(job.id, retryModel || null))}
        >
          Retry with {retryModel || 'spec default'}
        </button>
      )}
      {(job.status === 'queued' || job.status === 'running') && (
        <button type="button" onClick={() => setConfirm('cancel')}>
          Cancel
        </button>
      )}
      {DELETABLE.has(job.status) && (
        <button type="button" className="danger" onClick={() => setConfirm('delete')}>
          Delete
        </button>
      )}
      {alert}
    </>
  );
}
