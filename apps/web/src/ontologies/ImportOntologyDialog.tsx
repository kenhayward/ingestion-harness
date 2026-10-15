import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  ONTOLOGY_ACCEPT,
  ONTOLOGY_ID_RE,
  ontologyUrlProblem,
  type OntologySettings,
  type OntologySummary,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { Segmented } from '../ui/Segmented.js';
import { slugify, splitTags } from './derive.js';

type Source = 'file' | 'url';

/** Why an id is refused (ONTOLOGY_ID_RE), with the lower-case form to try; null when valid. */
export function ontologyIdProblem(id: string): string | null {
  if (!id || ONTOLOGY_ID_RE.test(id)) return null;
  const suggestion = slugify(id);
  return (
    'The id must be 2-63 lower-case letters, digits or hyphens, starting with a letter or digit' +
    (ONTOLOGY_ID_RE.test(suggestion) ? ` (try ${suggestion})` : '')
  );
}

/**
 * Import a file, or an allowlisted URL the worker fetches, as a new ontology or as the next
 * version of an existing one (same id).
 */
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
  const idErrorId = useId();
  const urlErrorId = useId();
  const reasonId = useId();
  const [source, setSource] = useState<Source>('file');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [settings, setSettings] = useState<OntologySettings | null>(null);
  const [label, setLabel] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [tags, setTags] = useState('');
  const [localOnly, setLocalOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (source !== 'url' || settings) return;
    api.getOntologySettings().then(setSettings, (err: Error) => setError(err.message));
  }, [api, source, settings]);

  const trimmed = id.trim();
  const match = existing.find((o) => o.id === trimmed);
  const hosts = settings?.fetchHosts ?? [];
  const off = settings !== null && !hosts.some((h) => h.trim());
  const urlProblem = url.trim() ? ontologyUrlProblem(url.trim(), hosts) : null;
  const hasSource =
    source === 'file' ? file !== null : settings !== null && url.trim() !== '' && !urlProblem;
  const idProblem = ontologyIdProblem(trimmed);
  // The first thing missing, said on the disabled Import button (hover) and in the dialog.
  const blocker = (() => {
    if (source === 'file') {
      if (!file) return 'Choose an ontology file';
    } else {
      if (settings === null) return 'Loading the allowed hosts…';
      if (off) return 'URL imports are off';
      if (!url.trim()) return "Enter the ontology's URL";
      if (urlProblem) return urlProblem;
    }
    if (match === undefined && !label.trim()) return 'Enter a name';
    if (!trimmed) return 'Enter an id';
    return idProblem;
  })();
  const ready = hasSource && blocker === null;
  // Problems already shown beside their field describe the button there; the rest get a line.
  const describedBy =
    blocker === null
      ? undefined
      : blocker === idProblem
        ? idErrorId
        : blocker === urlProblem
          ? urlErrorId
          : reasonId;
  const touched = file !== null || url.trim() !== '' || label.trim() !== '' || trimmed !== '';

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    const fields = match
      ? { id: trimmed }
      : { id: trimmed, label: label.trim(), tags: splitTags(tags), localOnly };
    try {
      if (source === 'file' && file) await api.importOntology(file, fields);
      else await api.importOntologyFromUrl({ ...fields, url: url.trim() });
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
        <button
          type="submit"
          form={formId}
          className="primary"
          disabled={busy || !ready}
          title={blocker ?? undefined}
          aria-describedby={describedBy}
        >
          Import
        </button>
      }
    >
      <form id={formId} className="dialog-form" onSubmit={(ev) => void submit(ev)}>
        <Segmented
          label="Source"
          options={[
            { value: 'file', label: 'From a file' },
            { value: 'url', label: 'From a URL' },
          ]}
          value={source}
          onChange={setSource}
        />
        {source === 'file' ? (
          <>
            <label>
              Ontology file
              <input
                type="file"
                accept={ONTOLOGY_ACCEPT}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <p className="muted">Turtle, RDF/XML, JSON-LD, N-Triples or N3 ({ONTOLOGY_ACCEPT}).</p>
          </>
        ) : (
          <>
            <label>
              URL
              <input
                type="url"
                className="mono"
                value={url}
                placeholder="https://"
                disabled={off}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            {settings === null && !error && <p className="muted">Loading the allowed hosts…</p>}
            {off && (
              <p className="muted">
                URL imports are off: an operator lists the hosts in ONTOLOGY_FETCH_ALLOW.
              </p>
            )}
            {settings !== null && !off && (
              <p className="muted">Allowed hosts: {hosts.join(', ')}</p>
            )}
            {urlProblem && !off && (
              <p className="field-error" id={urlErrorId}>
                {urlProblem}
              </p>
            )}
          </>
        )}
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
            aria-invalid={idProblem !== null}
            aria-describedby={idProblem ? idErrorId : undefined}
            onChange={(e) => {
              setId(e.target.value);
              setIdEdited(true);
            }}
          />
        </label>
        {idProblem && (
          <p className="field-error" id={idErrorId}>
            {idProblem}
          </p>
        )}
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
        {blocker && describedBy === reasonId && touched && (
          <p className="muted" id={reasonId}>
            To import: {blocker.charAt(0).toLowerCase() + blocker.slice(1)}
            {blocker.endsWith('…') ? '' : '.'}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
