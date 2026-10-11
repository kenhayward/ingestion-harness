import { useState } from 'react';
import type { Api } from '../api/client.js';

/** Bulk delete of finished jobs by age: preview (dry run) first, then confirm. */
export function JobCleanup({ api, onChanged }: { api: Api; onChanged: () => void }) {
  const [days, setDays] = useState(30);
  const [preview, setPreview] = useState<number | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (dryRun: boolean) => {
    setError(null);
    setDone(null);
    try {
      const res = await api.cleanupJobs(days, dryRun);
      if (dryRun) {
        setPreview(res.count ?? 0);
      } else {
        setPreview(null);
        setDone(`Deleted ${res.deleted ?? 0} jobs.`);
        onChanged();
      }
    } catch (err) {
      setPreview(null);
      setError((err as Error).message);
    }
  };

  return (
    <section className="job-cleanup" aria-label="Clean up old jobs">
      <label className="inline">
        Delete finished jobs older than (days)
        <input
          type="number"
          min={1}
          value={days}
          onChange={(e) => {
            setDays(Number(e.target.value));
            setPreview(null);
          }}
        />
      </label>
      <button type="button" onClick={() => void act(true)}>
        Preview
      </button>
      {preview === 0 && <p>{`No finished jobs older than ${days} days.`}</p>}
      {preview !== null && preview > 0 && (
        <p>
          {`${preview} jobs will be deleted (published copies are kept).`}{' '}
          <button type="button" className="danger" onClick={() => void act(false)}>
            Delete {preview} jobs
          </button>
          <button type="button" onClick={() => setPreview(null)}>
            Keep
          </button>
        </p>
      )}
      {done && <p role="status">{done}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
