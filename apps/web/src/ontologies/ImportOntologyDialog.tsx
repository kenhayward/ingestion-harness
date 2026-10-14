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
  const ready =
    hasSource && ONTOLOGY_ID_RE.test(trimmed) && (match !== undefined || label.trim() !== '');

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
        <button type="submit" form={formId} className="primary" disabled={busy || !ready}>
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
            {urlProblem && !off && <p className="field-error">{urlProblem}</p>}
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
