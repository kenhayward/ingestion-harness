import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  ONTOLOGY_ACCEPT,
  ONTOLOGY_ID_RE,
  ONTOLOGY_MAX_FILES,
  fileOntologyIds,
  ontologyFormat,
  ontologyUrlProblem,
  type OntologyBatchResult,
  type OntologySettings,
  type OntologySummary,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { Segmented } from '../ui/Segmented.js';
import { slugify, splitTags } from './derive.js';

type Source = 'file' | 'folder' | 'url';
type Mode = 'merge' | 'separate';

/** Why an id is refused (ONTOLOGY_ID_RE), with the lower-case form to try; null when valid. */
export function ontologyIdProblem(id: string): string | null {
  if (!id || ONTOLOGY_ID_RE.test(id)) return null;
  const suggestion = slugify(id);
  return (
    'The id must be 2-63 lower-case letters, digits or hyphens, starting with a letter or digit' +
    (ONTOLOGY_ID_RE.test(suggestion) ? ` (try ${suggestion})` : '')
  );
}

const PREFIX_RE = /^([a-z0-9][a-z0-9-]{0,39})?$/;
const PREFIX_RULE = 'The id prefix must be up to 40 lower-case letters, digits or hyphens';
/** Ids listed before "and n more" in the one-per-file preview. */
const PREVIEW = 8;

/** A path no import takes: a hidden file, or one inside a hidden folder (as the API skips). */
const hidden = (path: string) => path.split('/').some((s) => s.startsWith('.'));

interface PickedFolder {
  /** The ontology files, with their paths in the folder, in path order. */
  files: { file: File; path: string }[];
  /** Other (not hidden) files left out. */
  others: number;
  name: string;
}

function pickFolder(list: FileList | null): PickedFolder | null {
  const all = [...(list ?? [])]
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }))
    .filter((f) => !hidden(f.path));
  if (!all.length) return null;
  const files = all
    .filter((f) => ontologyFormat(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const first = all[0]!.path;
  return {
    files,
    others: all.length - files.length,
    name: first.includes('/') ? first.split('/')[0]! : 'files',
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a folder import did, for the page: versions queued, and why files were skipped. */
export function batchNote(result: OntologyBatchResult): string {
  const queued = `${plural(result.versions.length, 'version')} queued.`;
  if (!result.skipped.length) return queued;
  const shown = result.skipped.slice(0, 5).map((s) => `${s.fileName} (${s.reason})`);
  const more = result.skipped.length > 5 ? `, and ${result.skipped.length - 5} more` : '';
  return `${queued} ${plural(result.skipped.length, 'file')} skipped: ${shown.join(', ')}${more}.`;
}

/** A prefix from a folder or zip name: `IDMP-O 1.4` -> `idmp-o-1-4-`. */
const prefixFrom = (name: string) => {
  const slug = slugify(name);
  return slug ? `${slug.slice(0, 39)}-` : '';
};

/**
 * Import a file, a folder or zip (merged into one ontology, or one ontology per file), or an
 * allowlisted URL the worker fetches, as a new ontology or as the next version of an existing
 * one (same id).
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
  /** `note`: what a folder import did (versions queued, files skipped). */
  onImported: (note?: string) => void;
}) {
  const formId = useId();
  const idErrorId = useId();
  const urlErrorId = useId();
  const reasonId = useId();
  const previewId = useId();
  const [source, setSource] = useState<Source>('file');
  const [file, setFile] = useState<File | null>(null);
  const [folder, setFolder] = useState<PickedFolder | null>(null);
  const [zip, setZip] = useState<File | null>(null);
  const [mode, setMode] = useState<Mode>('merge');
  const [prefix, setPrefix] = useState('');
  const [prefixEdited, setPrefixEdited] = useState(false);
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

  const separate = source === 'folder' && mode === 'separate';
  const trimmed = id.trim();
  const match = separate ? undefined : existing.find((o) => o.id === trimmed);
  const hosts = settings?.fetchHosts ?? [];
  const off = settings !== null && !hosts.some((h) => h.trim());
  const urlProblem = url.trim() ? ontologyUrlProblem(url.trim(), hosts) : null;
  const idProblem = separate ? null : ontologyIdProblem(trimmed);
  const prefixProblem = separate && !PREFIX_RE.test(prefix.trim()) ? PREFIX_RULE : null;
  const previewIds =
    separate && folder
      ? fileOntologyIds(
          folder.files.map((f) => f.path),
          prefix.trim(),
        )
      : [];

  // The first thing missing, said on the disabled Import button (hover) and in the dialog.
  const blocker = (() => {
    if (source === 'file') {
      if (!file) return 'Choose an ontology file';
    } else if (source === 'folder') {
      if (!folder && !zip) return 'Choose a folder or a .zip';
      if (folder && !folder.files.length) return 'The folder has no ontology files';
      if (folder && folder.files.length > ONTOLOGY_MAX_FILES) {
        return `At most ${ONTOLOGY_MAX_FILES} ontology files per import`;
      }
      if (separate) return prefixProblem;
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
  const ready = blocker === null;
  // Problems already shown beside their field describe the button there; the rest get a line.
  const describedBy =
    blocker === null
      ? undefined
      : blocker === idProblem
        ? idErrorId
        : blocker === urlProblem
          ? urlErrorId
          : reasonId;
  const touched =
    file !== null ||
    folder !== null ||
    zip !== null ||
    url.trim() !== '' ||
    label.trim() !== '' ||
    trimmed !== '';

  const chooseFolder = (picked: PickedFolder | null) => {
    setFolder(picked);
    setZip(null);
    if (picked && !prefixEdited) setPrefix(prefixFrom(picked.name));
  };
  const chooseZip = (picked: File | null) => {
    setZip(picked);
    setFolder(null);
    if (picked && !prefixEdited) setPrefix(prefixFrom(picked.name.replace(/\.zip$/i, '')));
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    const meta = match ? {} : { label: label.trim(), tags: splitTags(tags), localOnly };
    try {
      if (source === 'folder') {
        const files = zip ? [{ file: zip, path: zip.name }] : (folder?.files ?? []);
        const result = await api.importOntologyBatch(
          files,
          separate
            ? { mode: 'separate', idPrefix: prefix.trim(), tags: splitTags(tags), localOnly }
            : { mode: 'merge', id: trimmed, ...meta },
        );
        onImported(batchNote(result));
        return;
      }
      const fields = { id: trimmed, ...meta };
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
            { value: 'folder', label: 'From a folder or .zip' },
            { value: 'url', label: 'From a URL' },
          ]}
          value={source}
          onChange={setSource}
        />
        {source === 'file' && (
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
        )}
        {source === 'folder' && (
          <>
            <label>
              Ontology folder
              <input
                type="file"
                multiple
                {...{ webkitdirectory: '', directory: '' }}
                onChange={(e) => chooseFolder(pickFolder(e.target.files))}
              />
            </label>
            <label>
              or a .zip
              <input
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => chooseZip(e.target.files?.[0] ?? null)}
              />
            </label>
            {folder && (
              <p className="muted">
                {plural(folder.files.length, 'ontology file')}
                {folder.others > 0 && ` · ${plural(folder.others, 'other file')} left out`}
              </p>
            )}
            {zip && <p className="muted">{zip.name}: its ontology files are read on import.</p>}
            <Segmented
              label="Import as"
              options={[
                { value: 'merge', label: 'One ontology' },
                { value: 'separate', label: 'One ontology per file' },
              ]}
              value={mode}
              onChange={setMode}
            />
            <p className="muted">
              {mode === 'merge'
                ? 'All the files become one version of one ontology; imports between them stay inside it.'
                : 'Each file becomes its own ontology, named after the file; imports between them resolve to each other.'}
            </p>
          </>
        )}
        {source === 'url' && (
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
        {separate ? (
          <>
            <label>
              Id prefix
              <input
                className="mono"
                value={prefix}
                aria-invalid={prefixProblem !== null}
                onChange={(e) => {
                  setPrefix(e.target.value);
                  setPrefixEdited(true);
                }}
              />
            </label>
            {prefixProblem && <p className="field-error">{prefixProblem}</p>}
            {folder && folder.files.length > 0 && (
              <>
                <p className="muted" id={previewId}>
                  Ontologies to import
                </p>
                <ul className="mono" aria-labelledby={previewId}>
                  {previewIds.slice(0, PREVIEW).map((oid) => {
                    const known = existing.find((o) => o.id === oid);
                    return (
                      <li key={oid}>
                        {oid} {known ? `(adds version ${known.versionCount + 1})` : '(new)'}
                      </li>
                    );
                  })}
                  {previewIds.length > PREVIEW && (
                    <li className="muted">… and {previewIds.length - PREVIEW} more</li>
                  )}
                </ul>
              </>
            )}
            {zip && <p className="muted">Ids come from the names of the files in the zip.</p>}
          </>
        ) : (
          <>
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
          </>
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
