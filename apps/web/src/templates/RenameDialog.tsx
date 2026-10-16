import { useId, useState, type FormEvent } from 'react';
import type { Api, TemplateListItem } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';

/**
 * Renames a document type (Document types card). The name lives in each version's recipe, and
 * published versions are immutable, so the open draft takes it, or a new draft from the latest
 * published version when none is open; the Workbench project is renamed at once (the API's
 * `PUT /api/templates/{id}/name`). Keeps a refusal as an alert.
 */
export function RenameDialog({
  api,
  item,
  onRenamed,
  onClose,
}: {
  api: Api;
  item: TemplateListItem;
  /** The new name and the version that now carries it. */
  onRenamed: (name: string, version: number) => void;
  onClose: () => void;
}) {
  const formId = useId();
  const [name, setName] = useState(item.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || trimmed === item.name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { record } = await api.renameTemplate(item.id, trimmed);
      onRenamed(trimmed, record.version);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Rename ${item.name}`}
      onClose={onClose}
      actions={
        <button
          type="submit"
          form={formId}
          className="primary"
          disabled={busy || !trimmed || trimmed === item.name}
        >
          Rename
        </button>
      }
    >
      <form
        id={formId}
        className="dialog-form"
        aria-label={`Rename ${item.name}`}
        onSubmit={(e) => void submit(e)}
      >
        <label>
          Name
          <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="muted">
          {item.draft !== null
            ? `Draft v${item.draft} gets the new name; published versions keep theirs until it is published.`
            : `Published versions cannot change, so this starts draft v${(item.published ?? 0) + 1} from v${item.published} with the new name; uploads use it once that draft is published.`}{' '}
          The id <span className="mono">{item.id}</span> stays, and so does the Workbench project,
          which takes the new name at once.
        </p>
        {error && <p role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
