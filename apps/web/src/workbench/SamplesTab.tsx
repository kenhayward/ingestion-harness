import { useCallback, useEffect, useState } from 'react';
import { MAX_SAMPLES, type SampleRole, type SampleView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { SampleText } from './SampleText.js';

/** Upload, triage and roles of a project's sample PDFs. Polls while any is preparing. */
export function SamplesTab({
  api,
  projectId,
  pollMs,
  onChanged,
}: {
  api: Api;
  projectId: string;
  pollMs: number;
  /** Called after a successful upload, retry, role change or removal. */
  onChanged?: () => void;
}) {
  const [samples, setSamples] = useState<SampleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSamples(await api.listSamples(projectId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const preparing = samples?.some((s) => s.state === 'preparing') ?? false;
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [preparing, pollMs, refresh]);

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    }
    await refresh();
  };

  const upload = async (files: File[]) => {
    setUploading(true);
    const failures: string[] = [];
    let uploaded = 0;
    for (const file of files) {
      try {
        await api.uploadSample(projectId, file, 'dev');
        uploaded += 1;
      } catch (err) {
        failures.push(`${file.name}: ${(err as Error).message}`);
      }
    }
    setUploading(false);
    setError(failures.length ? failures.join('; ') : null);
    if (uploaded > 0) onChanged?.();
    await refresh();
  };

  return (
    <div className="samples">
      <p className="muted">
        Add 3–8 sample PDFs to develop with, plus a few held out for testing (at most {MAX_SAMPLES}
        ). Each is prepared in the background: text extraction, then OCR for pages without a text
        layer.
      </p>
      <label className="file-pick">
        Add sample PDFs
        <input
          type="file"
          accept="application/pdf"
          multiple
          disabled={uploading}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) void upload(files);
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {samples === null ? (
        <p>Loading…</p>
      ) : samples.length === 0 ? (
        <p>No samples yet.</p>
      ) : (
        <table aria-label="Samples">
          <thead>
            <tr>
              <th>File</th>
              <th>Role</th>
              <th>Pages</th>
              <th>OCR pages</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {samples.map((s) => (
              <tr key={s.id}>
                <td>{s.filename}</td>
                <td>
                  <select
                    aria-label={`Role of ${s.filename}`}
                    value={s.role}
                    onChange={(e) =>
                      void act(() =>
                        api.setSampleRole(projectId, s.id, e.target.value as SampleRole),
                      )
                    }
                  >
                    <option value="dev">dev</option>
                    <option value="holdout">holdout</option>
                  </select>
                </td>
                <td>{s.triage?.pageCount ?? '—'}</td>
                <td>{s.triage ? s.triage.ocrPages.length : '—'}</td>
                <td>
                  {s.state}
                  {s.error && <small> — {s.error}</small>}
                  {s.holdoutRuns > 0 && (
                    <>
                      {' '}
                      <small className="muted">
                        used in {s.holdoutRuns} holdout evaluation{s.holdoutRuns === 1 ? '' : 's'}
                      </small>
                    </>
                  )}
                </td>
                <td>
                  {s.state === 'ready' && (
                    <button
                      type="button"
                      aria-label={`${viewing === s.id ? 'Hide' : 'View'} text of ${s.filename}`}
                      onClick={() => setViewing(viewing === s.id ? null : s.id)}
                    >
                      {viewing === s.id ? 'Hide text' : 'View text'}
                    </button>
                  )}
                  {s.state === 'failed' && s.prepareJobId && (
                    <button
                      type="button"
                      aria-label={`Retry ${s.filename}`}
                      onClick={() => void act(() => api.retryJob(s.prepareJobId!))}
                    >
                      Retry
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${s.filename}`}
                    onClick={() => void act(() => api.removeSample(projectId, s.id))}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {viewing && <SampleText key={viewing} api={api} projectId={projectId} sampleId={viewing} />}
    </div>
  );
}
