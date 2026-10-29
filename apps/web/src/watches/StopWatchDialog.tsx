import { useState } from 'react';
import type { StopBody, WatchView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';

/**
 * Stopping a watch: Drain lets what was admitted finish and move as usual, nothing new is taken;
 * Stop now ends pickups at once. A draining watch can only be stopped now.
 */
export function StopWatchDialog({
  api,
  watch,
  onClose,
  onStopped,
}: {
  api: Api;
  watch: WatchView;
  onClose: () => void;
  onStopped: (watch: WatchView) => void;
}) {
  const draining = watch.state === 'draining';
  const [mode, setMode] = useState<StopBody['mode']>(draining ? 'now' : 'drain');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      onStopped(await api.stopWatch(watch.id, { mode }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Stop ${watch.name}?`}
      onClose={onClose}
      actions={
        <button type="button" className="danger" disabled={busy} onClick={() => void stop()}>
          Stop watch
        </button>
      }
    >
      <fieldset className="stop-modes">
        <legend className="visually-hidden">How to stop</legend>
        <label>
          <input
            type="radio"
            name="stop-mode"
            checked={mode === 'drain'}
            disabled={draining}
            onChange={() => setMode('drain')}
          />
          <span>
            <strong>Drain</strong>
            <small className="muted">
              {draining
                ? 'Already draining: nothing new is being taken.'
                : 'Nothing new is taken. Documents already admitted run to the end and move as usual, then the watch shows Stopped.'}
            </small>
          </span>
        </label>
        <label>
          <input
            type="radio"
            name="stop-mode"
            checked={mode === 'now'}
            onChange={() => setMode('now')}
          />
          <span>
            <strong>Stop now</strong>
            <small className="muted">
              Pickups end at once: queued documents are cancelled and a running one is stopped.
              Files stay where they are, so cleaning up the folder is up to you.
            </small>
          </span>
        </label>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
