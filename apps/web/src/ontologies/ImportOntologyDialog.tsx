import { useId, useState, type FormEvent } from 'react';
import { ONTOLOGY_ACCEPT, ONTOLOGY_ID_RE, type OntologySummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { slugify, splitTags } from './derive.js';

/** Import a file as a new ontology, or as the next version of an existing one (same id). */
export function ImportOntologyDialog({
  api,
  existing,
  onClose,
  onImported,
}: {
  api: Api;
  existing: readonly OntologySummary[];
  onClose: () => void;
  onImported: () => void;
}) {
  const formId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [tags, setTags] = useState('');
  const [localOnly, setLocalOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = id.trim();
  const match = existing.find((o) => o.id === trimmed);
  const ready =
    file !== null && ONTOLOGY_ID_RE.test(trimmed) && (match !== undefined || label.trim() !== '');

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!file || !ready) return;
    setBusy(true);
    setError(null);
    try {
      await api.importOntology(
        file,
        match
          ? { id: trimmed }
          : { id: trimmed, label: label.trim(), tags: splitTags(tags), localOnly },
      );
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Import ontology"
      onClose={onClose}
      actions={
        <button type="submit" form={formId} className="primary" disabled={busy || !ready}>
          Import
        </button>
      }
    >
      <form id={formId} className="dialog-form" onSubmit={(ev) => void submit(ev)}>
        <label>
          Ontology file
          <input
            type="file"
            accept={ONTOLOGY_ACCEPT}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <p className="muted">Turtle, RDF/XML, JSON-LD, N-Triples or N3 ({ONTOLOGY_ACCEPT}).</p>
        <label>
          Name
          <input
            value={match ? match.label : label}
            disabled={match !== undefined}
            onChange={(e) => {
              setLabel(e.target.value);
              if (!idEdited) setId(slugify(e.target.value));
            }}
          />
        </label>
        <label>
          Id
          <input
            className="mono"
            value={id}
            onChange={(e) => {
              setId(e.target.value);
              setIdEdited(true);
            }}
          />
        </label>
        {match ? (
          <p className="muted" role="status">
            Adds version {match.versionCount + 1} of {match.label}.
          </p>
        ) : (
          <>
            <label>
              Tags (comma-separated)
              <input
                value={tags}
                placeholder="industry:pharma, customer:acme"
                onChange={(e) => setTags(e.target.value)}
              />
            </label>
            <label className="inline">
              <input
                type="checkbox"
                checked={localOnly}
                onChange={(e) => setLocalOnly(e.target.checked)}
              />
              Local only: never sent to external models
            </label>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
