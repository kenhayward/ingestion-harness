import { useId, useState, type FormEvent } from 'react';
import type { OntologySummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { splitTags } from './derive.js';

/** Admin: an ontology's name, description, tags, local only and retired. */
export function EditOntologyDialog({
  api,
  ontology,
  onClose,
  onSaved,
}: {
  api: Api;
  ontology: OntologySummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const formId = useId();
  const [label, setLabel] = useState(ontology.label);
  const [description, setDescription] = useState(ontology.description);
  const [tags, setTags] = useState(ontology.tags.join(', '));
  const [localOnly, setLocalOnly] = useState(ontology.localOnly);
  const [retired, setRetired] = useState(ontology.retiredAt !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateOntology(ontology.id, {
        label: label.trim(),
        description,
        tags: splitTags(tags),
        localOnly,
        retired,
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Edit ontology"
      onClose={onClose}
      actions={
        <button type="submit" form={formId} className="primary" disabled={busy || !label.trim()}>
          Save
        </button>
      }
    >
      <form id={formId} className="dialog-form" onSubmit={(ev) => void submit(ev)}>
        <label>
          Name
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          Description
          <textarea value={description} rows={3} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Tags (comma-separated)
          <input value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={localOnly}
            onChange={(e) => setLocalOnly(e.target.checked)}
          />
          Local only: never sent to external models
        </label>
        <label className="inline">
          <input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} />
          Retired
        </label>
        <p className="muted">
          A retired ontology is hidden from the library; anything that uses it keeps working.
        </p>
        {error && <p role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
