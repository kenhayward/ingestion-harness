import { useCallback, useEffect, useState } from 'react';
import type { DataPolicy, ExportView } from '@ih/shared';
import type { Api } from '../api/client.js';

const ACTIVE = new Set(['queued', 'running']);

/** Export the project's drafting bundle (dev samples only) and download the latest one. */
export function ExportPanel({
  api,
  projectId,
  dataPolicy,
  pollMs = 3000,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  pollMs?: number;
}) {
  const [latest, setLatest] = useState<ExportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const all = await api.listExports(projectId);
      setLatest(all[0] ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = latest !== null && ACTIVE.has(latest.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [active, pollMs, refresh]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setLatest(await api.startExport(projectId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-label="Drafting bundle">
      <h3>Drafting bundle</h3>
      <p className="muted">
        The drafting context, stage instructions, brief, draft and dev sample PDFs — never holdout
        samples — for drafting elsewhere or importing into another deployment.
      </p>
      {dataPolicy === 'local' && (
        <p className="muted">Exporting a local-only project needs the admin token.</p>
      )}
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy || active} onClick={() => void start()}>
        Export bundle
      </button>
      {latest && (
        <p role="status">
          {latest.status === 'succeeded' ? (
            <>
              Export ready.{' '}
              <a href={api.exportBundleUrl(projectId, latest.jobId)} download>
                Download bundle
              </a>
            </>
          ) : active ? (
            `Export ${latest.status}…`
          ) : (
            `Export ${latest.status === 'cancelled' ? 'cancelled' : 'failed'}${
              latest.error ? `: ${latest.error}` : ''
            }`
          )}
        </p>
      )}
    </section>
  );
}
