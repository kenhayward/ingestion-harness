import { useCallback, useEffect, useState } from 'react';
import type { GateView, Publication } from '@ih/shared';
import type { Api } from '../api/client.js';

const MIN_OVERRIDE_CHARS = 10;
const MAX_OVERRIDE_CHARS = 1000;
const DOT = '·';
const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);

/**
 * Publish gate (ADR 0007): the newest holdout score of this draft against the threshold, and the
 * publication log. Without an open draft only the log and the threshold are shown.
 */
export function PublishPanel({
  api,
  projectId,
  draft,
  refreshKey,
  onPublished,
}: {
  api: Api;
  projectId: string;
  /** The open draft version; null when every version is published. */
  draft: number | null;
  /** Changes when the gate may have changed (e.g. the latest evaluation completed). */
  refreshKey?: string;
  onPublished: () => void;
}) {
  const [gate, setGate] = useState<GateView | null>(null);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [threshold, setThreshold] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [published, setPublished] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextGate, nextPublications, view] = await Promise.all([
        draft === null ? null : api.getPublishGate(projectId),
        api.listPublications(projectId),
        api.getProject(projectId),
      ]);
      setGate(nextGate);
      setPublications(nextPublications);
      setThreshold(String(Math.round(view.project.publishThreshold * 100)));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId, draft]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveThreshold = () =>
    act(async () => {
      await api.setPublishThreshold(projectId, Number(threshold) / 100);
      await load();
    });
  const publish = () =>
    act(async () => {
      const reason = gate && !gate.passes ? overrideReason.trim() : '';
      const result = await api.publish(projectId, reason || undefined);
      setPublished(result.publication.version);
      setOverrideReason('');
      onPublished();
      await load();
    });

  const needsOverride = gate !== null && !gate.passes;
  const thresholdValid = threshold !== '' && Number(threshold) >= 0 && Number(threshold) <= 100;

  return (
    <section aria-label="Publish">
      <h3>Publish</h3>
      {draft === null ? (
        <p>Every version is published; start the next version on the Template tab</p>
      ) : (
        gate && <p>{gate.reason}</p>
      )}
      <div className="actions">
        <label>
          Publish threshold (%){' '}
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={busy || !thresholdValid}
          onClick={() => void saveThreshold()}
        >
          Save threshold
        </button>
      </div>
      {draft !== null && needsOverride && (
        <label>
          Override reason
          <textarea
            value={overrideReason}
            maxLength={MAX_OVERRIDE_CHARS}
            onChange={(e) => setOverrideReason(e.target.value)}
          />
        </label>
      )}
      {draft !== null && (
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={
              busy ||
              gate === null ||
              (needsOverride && overrideReason.trim().length < MIN_OVERRIDE_CHARS)
            }
            onClick={() => void publish()}
          >
            Publish v{draft}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {published !== null && <p role="status">Published v{published}</p>}
      {publications.length > 0 && (
        <ul aria-label="Publications">
          {publications.map((p) => (
            <li key={p.id}>
              v{p.version} {DOT} {new Date(p.publishedAt).toLocaleString()} {DOT} {pct(p.score)}
              {p.overrideReason && (
                <>
                  {' '}
                  {DOT} <small className="muted">override: {p.overrideReason}</small>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
