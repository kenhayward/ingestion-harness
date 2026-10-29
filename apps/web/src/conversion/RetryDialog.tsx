import { useRef, useState } from 'react';
import type { Batch, BatchDetail, ConversionTarget, Item } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Re-run failed documents (`POST /api/conversions/batches/:id/retry`): each runs again in this
 * batch from the file uploaded with it, its row queued again (owner's call, 2026-10-29: no new
 * batch, so it is plain which documents have since gone through). Every listed document starts
 * ticked; Force-load starts as the batch was started, and Auto approve off. On success the batch
 * as now goes to `onDone`, and the dialog closes; a refusal (one already running again, say)
 * stays in the dialog.
 */
export function RetryDialog({
  api,
  batch,
  items,
  target,
  title,
  onDone,
  onClose,
}: {
  api: Api;
  batch: Batch;
  /** The failed documents offered. */
  items: Item[];
  target: ConversionTarget | undefined;
  title: string;
  /** The batch as the re-run left it. */
  onDone: (detail: BatchDetail) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(items.map((i) => i.id)));
  const [force, setForce] = useState(batch.force);
  const [autoApprove, setAutoApprove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const chosen = items.filter((i) => picked.has(i.id));

  async function rerun() {
    if (sending.current || chosen.length === 0) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const detail = await api.retryConversionItems(batch.id, {
        itemIds: chosen.map((i) => i.id),
        force,
        autoApprove,
      });
      onDone(detail);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      sending.current = false;
      setBusy(false);
    }
  }

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Dialog
      title={title}
      onClose={onClose}
      className="retry-dialog"
      actions={
        <button
          type="button"
          className="primary"
          disabled={busy || chosen.length === 0}
          onClick={() => void rerun()}
        >
          Re-run {plural(chosen.length, 'document')}
        </button>
      }
    >
      <p>
        {items.length === 1 ? 'It runs' : 'They run'} again in this batch, from the{' '}
        {items.length === 1 ? 'file' : 'files'} uploaded with it, to{' '}
        <strong>{target?.label ?? batch.targetId}</strong>
        {target && <span className="sink-tag">{target.sinkName}</span>}.{' '}
        {items.length === 1 ? 'Its row shows' : 'Their rows show'} how{' '}
        {items.length === 1 ? 'it goes' : 'they go'}.
      </p>
      <div className="retry-list">
        <p className="retry-list-head">
          <strong>{plural(items.length, 'document')}</strong>
          <span className="muted"> · failed in this batch</span>
        </p>
        <ul>
          {items.map((i) => (
            <li key={i.id}>
              <label>
                <input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} />
                <span>
                  <span className="mono">{i.sourceKey}</span>
                  {i.detail && <small className="muted">{i.detail}</small>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>
      <label className="conv-switch">
        <input
          type="checkbox"
          role="switch"
          checked={force}
          onChange={(e) => setForce(e.target.checked)}
        />
        <span className="conv-switch-track" aria-hidden="true" />
        Keep Force-load
        <span className="muted">
          {' '}
          · {batch.force ? 'as this batch was started' : 'off for this batch'}
        </span>
      </label>
      <label className="conv-switch">
        <input
          type="checkbox"
          role="switch"
          checked={autoApprove}
          onChange={(e) => setAutoApprove(e.target.checked)}
        />
        <span className="conv-switch-track" aria-hidden="true" />
        Auto approve
        <span className="muted"> · deliver converted PDFs without holding them for review</span>
      </label>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
