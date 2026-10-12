import { useState } from 'react';
import type { Api } from '../api/client.js';

const MAX_DAYS = 3650;
const jobs = (n: number) => `${n} ${n === 1 ? 'job' : 'jobs'}`;

/**
 * Bulk delete of finished jobs by age: preview (dry run) first, then delete exactly the jobs the
 * preview counted (its cutoff is sent back), in batches so a large first clean-up doesn't time out.
 */
export function JobCleanup({ api, onChanged }: { api: Api; onChanged: () => void }) {
  const [daysText, setDaysText] = useState('30');
  const [includeRegression, setIncludeRegression] = useState(false);
  const [preview, setPreview] = useState<{ count: number; cutoff: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const days = Number(daysText);
  const valid = /^\d+$/.test(daysText) && days >= 1 && days <= MAX_DAYS;

  const reset = () => {
    setPreview(null);
    setDone(null);
    setError(null);
  };

  const runPreview = async () => {
    reset();
    try {
      const res = await api.cleanupJobs({ olderThanDays: days, dryRun: true, includeRegression });
      setPreview({ count: res.count ?? 0, cutoff: res.cutoff });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const runDelete = async () => {
    if (!preview) return;
    const { count, cutoff } = preview;
    setBusy(true);
    setError(null);
    let deleted = 0;
    try {
      for (;;) {
        const res = await api.cleanupJobs({
          olderThanDays: days,
          dryRun: false,
          includeRegression,
          cutoff,
        });
        deleted += res.deleted ?? 0;
        setDone(`Deleted ${deleted} of ${jobs(count)}…`);
        if (!res.remaining) break;
      }
      setPreview(null);
      setDone(`Deleted ${jobs(deleted)}.`);
    } catch (err) {
      setPreview(null);
      setDone(deleted ? `Deleted ${jobs(deleted)} before an error.` : null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <section className="job-cleanup" aria-label="Clean up old jobs">
      <label className="inline">
        Delete finished jobs older than (days)
        <input
          type="number"
          min={1}
          max={MAX_DAYS}
          step={1}
          value={daysText}
          aria-invalid={!valid}
          aria-describedby={valid ? undefined : 'cleanup-days-hint'}
          onChange={(e) => {
            setDaysText(e.target.value);
            reset();
          }}
        />
      </label>
      <label className="inline">
        <input
          type="checkbox"
          checked={includeRegression}
          onChange={(e) => {
            setIncludeRegression(e.target.checked);
            reset();
          }}
        />
        Include regression runs
      </label>
      <button type="button" disabled={!valid || busy} onClick={() => void runPreview()}>
        Preview
      </button>
      {!valid && <small id="cleanup-days-hint">Enter whole days from 1 to {MAX_DAYS}.</small>}
      {preview?.count === 0 && <p>{`No finished jobs older than ${days} days.`}</p>}
      {preview && preview.count > 0 && (
        <p>
          {`${jobs(preview.count)} will be deleted (published copies are kept).`}{' '}
          <button type="button" className="danger" disabled={busy} onClick={() => void runDelete()}>
            Delete {jobs(preview.count)}
          </button>
          <button type="button" disabled={busy} onClick={() => setPreview(null)}>
            Keep
          </button>
        </p>
      )}
      {done && <p role="status">{done}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
