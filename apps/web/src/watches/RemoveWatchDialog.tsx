import { useState } from 'react';
import type { WatchView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';

/** Removing a stopped watch: its batch stays as history; nothing in the folder is touched. */
export function RemoveWatchDialog({
  api,
  watch,
  onClose,
  onRemoved,
}: {
  api: Api;
  watch: WatchView;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.removeWatch(watch.id);
      onRemoved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Remove ${watch.name}?`}
      onClose={onClose}
      actions={
        <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
          Remove watch
        </button>
      }
    >
      <p>
        The watch, its counters and its events go. Its batch stays on the Conversion page as
        history, and nothing in the folder is touched.
      </p>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
