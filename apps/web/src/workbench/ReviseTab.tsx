import { useCallback, useEffect, useState } from 'react';
import {
  FEEDBACK_MAX_CHARS,
  FEEDBACK_TARGETS,
  type DataPolicy,
  type FeedbackItem,
  type FeedbackTarget,
  type SampleView,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { StagePanel } from './StagePanel.js';

/** Feedback on the draft, and the revision the model proposes in answer to it (ADR 0007). */
export function ReviseTab({
  api,
  projectId,
  dataPolicy,
  hasDraft,
  pollMs,
  onApplied,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  hasDraft: boolean;
  pollMs: number;
  onApplied: () => void;
}) {
  const [items, setItems] = useState<FeedbackItem[] | null>(null);
  const [samples, setSamples] = useState<SampleView[]>([]);
  const [target, setTarget] = useState<FeedbackTarget>('field');
  const [targetId, setTargetId] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await api.listFeedback(projectId));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    api.listSamples(projectId).then(setSamples, () => setSamples([]));
  }, [api, projectId]);

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

  const add = () =>
    act(async () => {
      await api.addFeedback(projectId, { target, targetId, body });
      setTargetId('');
      setBody('');
      await reload();
    });
  const remove = (id: string) =>
    act(async () => {
      await api.deleteFeedback(projectId, id);
      await reload();
    });

  const sampleName = (id: string) => samples.find((s) => s.id === id)?.filename ?? 'sample';

  return (
    <div className="revise-tab">
      <h3>Feedback</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label>
          About{' '}
          <select value={target} onChange={(e) => setTarget(e.target.value as FeedbackTarget)}>
            {FEEDBACK_TARGETS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Id{' '}
          <input
            value={targetId}
            aria-describedby="feedback-id-hint"
            onChange={(e) => setTargetId(e.target.value)}
          />
        </label>{' '}
        <small id="feedback-id-hint" className="muted">
          lowercase id, e.g. sent_on
        </small>
        <label>
          Feedback
          <textarea
            value={body}
            maxLength={FEEDBACK_MAX_CHARS}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="primary"
          disabled={busy || !targetId.trim() || !body.trim()}
        >
          Add feedback
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {items && items.length > 0 && (
        <table aria-label="Feedback">
          <thead>
            <tr>
              <th>About</th>
              <th>Id</th>
              <th>Sample</th>
              <th>Feedback</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((f) => (
              <tr key={f.id}>
                <td>{f.target}</td>
                <td>{f.targetId}</td>
                <td>{f.sampleId ? sampleName(f.sampleId) : ''}</td>
                <td>{f.body}</td>
                <td>{f.resolvedBy ? 'resolved' : 'open'}</td>
                <td>
                  {!f.resolvedBy && (
                    <button type="button" disabled={busy} onClick={() => void remove(f.id)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Revision</h3>
      <StagePanel
        api={api}
        projectId={projectId}
        stage="revise"
        dataPolicy={dataPolicy}
        hasDraft={hasDraft}
        pollMs={pollMs}
        canSkip={false}
        onApplied={() => {
          onApplied();
          void reload();
        }}
        onSkipped={() => undefined}
      />
    </div>
  );
}
