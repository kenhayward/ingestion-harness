import { useState } from 'react';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';

/**
 * Confirm deleting one version of an ontology (the detail page's selected version, a list row's
 * latest). A refusal stays in the dialog; deleting the only version deletes the ontology too.
 */
export function DeleteVersionDialog({
  api,
  ontology,
  version,
  versionCount,
  onClose,
  onDeleted,
}: {
  api: Api;
  ontology: { id: string; label: string };
  version: number;
  versionCount: number;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteOntologyVersion(ontology.id, version);
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Delete version ${version}`}
      onClose={onClose}
      actions={
        <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
          Delete version
        </button>
      }
    >
      <p>
        Deletes version {version} of {ontology.label}, its terms and its file.
        {versionCount === 1 ? ' It is the only version, so the ontology goes too.' : ''}
      </p>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
