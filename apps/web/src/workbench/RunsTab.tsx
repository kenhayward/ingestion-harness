import { useCallback, useEffect, useState } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Api } from '../api/client.js';

const REVIEWABLE = new Set(['awaiting_review', 'succeeded']);

/** Test runs of the open draft on the dev samples. Polls while any run is unfinished. */
export function RunsTab({
  api,
  projectId,
  draft,
  pollMs,
}: {
  api: Api;
  projectId: string;
  draft: number | null;
  pollMs: number;
}) {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setJobs(await api.listTestRuns(projectId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = jobs?.some((j) => j.status === 'queued' || j.status === 'running') ?? false;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [active, pollMs, refresh]);

  const run = async () => {
    setError(null);
    try {
      await api.runDevTests(projectId);
    } catch (err) {
      setError((err as Error).message);
    }
    await refresh();
  };

  return (
    <div className="runs">
      <p className="muted">
        Runs the draft{draft !== null ? ` v${draft}` : ''} on every prepared dev sample. Holdout
        samples are not used. Workbench runs queue behind production jobs.
      </p>
      <button
        type="button"
        className="primary"
        disabled={draft === null}
        onClick={() => void run()}
      >
        Run on dev samples
      </button>
      {error && <p role="alert">{error}</p>}
      {jobs !== null && jobs.length > 0 && (
        <table aria-label="Test runs">
          <thead>
            <tr>
              <th>File</th>
              <th>Version</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{j.filename}</td>
                <td>v{j.specVersion}</td>
                <td>
                  {j.status}
                  {j.error && <small> — {j.error}</small>}
                </td>
                <td>{REVIEWABLE.has(j.status) && <a href={`#/review/${j.id}`}>Review</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
