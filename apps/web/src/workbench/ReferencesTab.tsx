import { useCallback, useEffect, useState } from 'react';
import type { DataPolicy, ReferenceRow } from '@ih/shared';
import type { Api } from '../api/client.js';

const POLICY_NOTE: Record<DataPolicy, string> = {
  local: 'Runs on local models; holdout samples are never sent.',
  external:
    'Dev sample text may be sent to an external model provider; holdout samples are never sent.',
};

const reviewable = (status: string) => status === 'awaiting_review' || status === 'succeeded';
const active = (status: string) => status === 'queued' || status === 'running';

/** Stage 5 (ADR 0007): the draft model proposes values; the user verifies them in Review. */
export function ReferencesTab({
  api,
  projectId,
  dataPolicy,
  hasDraft,
  pollMs,
  onChanged,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  hasDraft: boolean;
  pollMs: number;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<ReferenceRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows(await api.listReferenceRows(projectId));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const running = rows?.some((r) => r.run !== null && active(r.run.status)) ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [running, pollMs, refresh]);

  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const propose = () =>
    act(async () => {
      const jobs = await api.proposeReferences(projectId);
      setMessage(`${jobs.length} run${jobs.length === 1 ? '' : 's'} queued`);
      onChanged();
      await refresh();
    });
  const skip = () =>
    act(async () => {
      await api.skipStage(projectId, 'references');
      setMessage('Stage skipped');
      onChanged();
    });

  return (
    <div className="references-tab">
      <p className="muted">{POLICY_NOTE[dataPolicy]}</p>
      <p className="muted">Open each run in Review, correct the values, and Save as reference.</p>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!hasDraft || busy || running}
          onClick={() => void propose()}
        >
          Run the draft model on unverified samples
        </button>
        <button type="button" disabled={busy} onClick={() => void skip()}>
          Skip this stage
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {rows === null ? (
        <p>Loading…</p>
      ) : (
        <table aria-label="References">
          <thead>
            <tr>
              <th>Sample</th>
              <th>Run</th>
              <th>Reference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sampleId}>
                <td>{r.filename}</td>
                <td>
                  {r.run ? (
                    <>
                      {r.run.status.replace('_', ' ')}
                      {r.run.error && <small className="muted"> {r.run.error}</small>}{' '}
                      {reviewable(r.run.status) && (
                        <a href={`#/review/${r.run.jobId}`}>Verify in Review</a>
                      )}
                    </>
                  ) : (
                    <span className="muted">No run yet</span>
                  )}
                </td>
                <td>
                  {r.reference ? (
                    `✓ ${r.reference.name}`
                  ) : (
                    <span className="muted">Not verified</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
