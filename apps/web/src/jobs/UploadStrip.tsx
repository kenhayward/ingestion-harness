import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { pickedChoice, type ModelChoice, type SpecSummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { CHOICES_FAILED, CHOICES_LOADING } from './derive.js';
import { isSourceFile, SOURCE_ACCEPT } from '../documents.js';
import { Icon } from '../ui/Icon.js';
import { ModelPicker, typeModelLabel } from '../ui/ModelPicker.js';

/** The model choice is remembered per browser ('' / absent = the document type's models). */
const MODEL_KEY = 'ih.uploadModel';

function loadModel(): string {
  try {
    return localStorage.getItem(MODEL_KEY) ?? '';
  } catch {
    return ''; // storage blocked (private window, policy): behave as before
  }
}

function saveModel(model: string): void {
  try {
    if (model) localStorage.setItem(MODEL_KEY, model);
    else localStorage.removeItem(MODEL_KEY);
  } catch {
    // storage blocked: the selection just isn't remembered
  }
}

type Pick = {
  key: string;
  file: File;
  status: 'ready' | 'uploading' | 'queued' | 'error' | 'skipped';
  message: string;
};

/** Still to send: never tried, or failed (the button retries those). */
const pending = (p: Pick) => p.status === 'ready' || p.status === 'error';
const filesLabel = (n: number) =>
  n === 0 ? 'Upload' : `Upload ${n} ${n === 1 ? 'file' : 'files'}`;

/**
 * Upload strip (UI handoff §1): drop or browse several PDFs or Word documents, each becomes its
 * own job, uploaded
 * one after another with a status per file.
 */
export function UploadStrip({
  api,
  onUploaded,
  pickPending = false,
  onPicked,
}: {
  api: Api;
  onUploaded: () => void;
  /** Upload document (top bar) was pressed: open the file picker, then report it with onPicked. */
  pickPending?: boolean;
  onPicked?: () => void;
}) {
  const inputId = useId();
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [models, setModels] = useState<readonly ModelChoice[]>(CHOICES_LOADING);
  const [spec, setSpec] = useState('');
  const [model, setModel] = useState('');
  const [picks, setPicks] = useState<Pick[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);
  /** A batch is uploading: rows added now must not drop its in-progress rows. */
  const uploading = useRef(false);

  /** StrictMode re-runs effects before onPicked lands: open the picker once per request. */
  const picking = useRef(false);

  useEffect(() => {
    if (!pickPending) {
      picking.current = false;
      return;
    }
    if (picking.current) return;
    picking.current = true;
    fileInput.current?.click();
    onPicked?.();
    // onPicked is a callback prop: the picker opens once per request, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickPending]);

  useEffect(() => {
    api.listSpecs().then(
      (listed) => {
        const all = listed.filter((s) => !s.retired); // the API leaves them out; never offer one
        // Only the newest version of each type: uploads should not pick an old one.
        const newest = new Map<string, number>();
        for (const s of all) newest.set(s.id, Math.max(newest.get(s.id) ?? 0, s.version));
        const list = all.filter((s) => s.version === newest.get(s.id));
        setSpecs(list);
        const first = list.at(-1);
        if (first) setSpec(`${first.id}@${first.version}`);
      },
      (err: Error) => setLoadError(`Failed to load specs: ${err.message}`),
    );
    api.listPickerChoices().then(
      (list) => {
        setModels(list);
        // Restore the remembered choice only if it can still be picked; otherwise forget it.
        const saved = loadModel();
        if (!saved) return;
        if (pickedChoice(saved, list)) setModel(saved);
        else {
          saveModel('');
        }
      },
      () => setModels(CHOICES_FAILED),
    );
  }, [api]);

  /** New files start a fresh selection once the last batch is done (failures stay to retry). */
  function add(files: readonly File[]) {
    if (!files.length) return;
    const added = files.map<Pick>((file) => ({
      key: String(nextKey.current++),
      file,
      status: isSourceFile(file) ? 'ready' : 'skipped',
      message: isSourceFile(file) ? 'Ready' : 'Not a PDF or Word document',
    }));
    setPicks((prev) => [...(uploading.current ? prev : prev.filter(pending)), ...added]);
  }

  const update = (key: string, status: Pick['status'], message: string) =>
    setPicks((prev) => prev.map((p) => (p.key === key ? { ...p, status, message } : p)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const todo = picks.filter(pending);
    if (!todo.length || !spec) return;
    const [specId, version] = spec.split('@');
    setBusy(true);
    uploading.current = true;
    let queued = 0;
    for (const p of todo) {
      update(p.key, 'uploading', 'Uploading…');
      try {
        await api.upload({
          file: p.file,
          specId: specId!,
          specVersion: Number(version),
          model: model || undefined,
        });
        update(p.key, 'queued', 'Queued');
        queued++;
      } catch (err) {
        update(p.key, 'error', `Upload failed: ${(err as Error).message}`);
      }
    }
    uploading.current = false;
    setBusy(false);
    if (queued) onUploaded();
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    add([...e.dataTransfer.files]);
  };
  const count = picks.filter(pending).length;

  return (
    <form className="upload-strip" onSubmit={submit} aria-label="Upload document">
      <label
        htmlFor={inputId}
        className={over ? 'drop-zone over' : 'drop-zone'}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span className="drop-icon" aria-hidden="true">
          <Icon name="upload" size={20} />
        </span>
        <span className="drop-text">
          <span>
            <strong>Drop PDF or Word files here</strong> or{' '}
            <span className="link-text">browse</span>
          </span>
          <small>Several at once — each becomes its own job</small>
        </span>
      </label>
      <input
        ref={fileInput}
        id={inputId}
        className="visually-hidden"
        type="file"
        accept={SOURCE_ACCEPT}
        multiple
        aria-label="PDF or Word files"
        onChange={(e) => {
          add([...(e.target.files ?? [])]);
          e.target.value = ''; // the same file can be picked again after a failure
        }}
      />
      <label className="field">
        Document type
        <select value={spec} onChange={(e) => setSpec(e.target.value)}>
          {specs.map((s) => (
            <option key={`${s.id}@${s.version}`} value={`${s.id}@${s.version}`}>
              {s.title} · v{s.version}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        Model
        <ModelPicker
          label="Model"
          choices={models}
          value={model}
          emptyLabel={typeModelLabel(
            models,
            specs.find((s) => `${s.id}@${s.version}` === spec),
          )}
          onChange={(next) => {
            setModel(next);
            saveModel(next);
          }}
        />
      </div>
      <button type="submit" className="primary" disabled={!count || !spec || busy}>
        {filesLabel(count)}
      </button>
      {picks.length > 0 && (
        <ul className="upload-list" aria-label="Uploads">
          {picks.map((p) => (
            <li key={p.key} className={`upload-${p.status}`}>
              <span className="mono">{p.file.name}</span>
              <span>{p.message}</span>
            </li>
          ))}
        </ul>
      )}
      {loadError && <p role="alert">{loadError}</p>}
    </form>
  );
}
