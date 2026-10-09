import type { JobSummary } from '@ih/shared';
import type { Api } from '../api/client.js';

export function JobsTable({
  api,
  jobs,
  onChanged,
}: {
  api: Api;
  jobs: JobSummary[];
  onChanged: () => void;
}) {
  if (jobs.length === 0) return <p>No jobs yet.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>File</th>
          <th>Spec</th>
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
              {job.status === 'awaiting_review' && <a href={`#/review/${job.id}`}>Review</a>}
              {(job.status === 'failed' || job.status === 'needs_review') && (
                <button onClick={() => api.retryJob(job.id).then(onChanged)}>Retry</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
