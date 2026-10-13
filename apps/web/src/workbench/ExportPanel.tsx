import { useCallback, useEffect, useState } from 'react';
import type { DataPolicy, ExportView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { exportStatusText } from './brief.js';

const ACTIVE = new Set(['queued', 'running']);

/** Export the project's drafting bundle (dev samples only) and download the latest one. */
export function ExportPanel({
  api,
  role,
  projectId,
  dataPolicy,
  pollMs = 3000,
}: {
  api: Api;
  /** The session's role: a local-only project's bundle downloads with the admin token only. */
  role: 'admin' | 'user';
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
      setError(null);
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

  const canDownload = dataPolicy !== 'local' || role === 'admin';
  const ready = latest?.status === 'succeeded';
  return (
    <section className="card export-panel" aria-labelledby="export-title">
      <h3 id="export-title">
        <Icon name="file" /> Drafting bundle
      </h3>
      <p className="muted">
        Brief, draft, stage instructions and the dev samples as uploaded — never holdout samples —
        to draft elsewhere or import into another deployment.
      </p>
      {error && <p role="alert">{error}</p>}
      {latest && (
        <p
          role="status"
          className={`export-status ${ready ? 'tone-text-ok' : active ? 'tone-text-info' : 'tone-text-danger'}`}
        >
          {ready && <Icon name="check" />} {exportStatusText(latest)}
        </p>
      )}
      <div className="export-actions">
        {latest?.status === 'succeeded' &&
          (canDownload ? (
            <a
              className="button primary"
              href={api.exportBundleUrl(projectId, latest.jobId)}
              download
              aria-label="Download bundle"
            >
              <Icon name="download" /> Download
            </a>
          ) : (
            <span className="muted">
              Downloading a local-only project&apos;s bundle needs the admin token.
            </span>
          ))}
        <button type="button" disabled={busy || active} onClick={() => void start()}>
          {latest ? 'Export again' : 'Export bundle'}
        </button>
      </div>
      {dataPolicy === 'local' && (
        <p className="muted export-note">
          Local-only project: exporting and downloading need the admin token.
        </p>
      )}
    </section>
  );
}
