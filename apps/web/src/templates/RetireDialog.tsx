import { useState } from 'react';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { unretireHint } from '../ui/retired.js';

/**
 * Confirms retiring a document type (admins; a recipe or a legacy spec). Runs only on its
 * Retire button, keeps a refusal as an alert, and reports success to the page, which reloads.
 */
export function RetireDialog({
  api,
  id,
  name,
  onRetired,
  onClose,
}: {
  api: Api;
  id: string;
  name: string;
  onRetired: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retire = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.retireType(id);
      onRetired();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Retire ${name}`}
      onClose={onClose}
      actions={
        <button type="button" className="primary" disabled={busy} onClick={() => void retire()}>
          Retire
        </button>
      }
    >
      <p>
        Retiring {name} (<span className="mono">{id}</span>) takes every version off this page,
        uploads and new work. Nothing is deleted: its jobs, results and references stay readable,
        and jobs already queued finish.
      </p>
      <p className="muted">{unretireHint(id)}</p>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
