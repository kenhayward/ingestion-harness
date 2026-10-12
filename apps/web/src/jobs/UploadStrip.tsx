import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from 'react';
import type { ModelInfo, SpecSummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';

/** The Model selection is remembered per browser ('' / absent = spec default). */
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

const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
/** Still to send: never tried, or failed (the button retries those). */
const pending = (p: Pick) => p.status === 'ready' || p.status === 'error';
const filesLabel = (n: number) =>
  n === 0 ? 'Upload' : `Upload ${n} ${n === 1 ? 'file' : 'files'}`;

/**
 * Upload strip (UI handoff §1): drop or browse several PDFs, each becomes its own job, uploaded
 * one after another with a status per file.
 */
export function UploadStrip({
  api,
  onUploaded,
  onModelChange,
  pickPending = false,
  onPicked,
}: {
  api: Api;
  onUploaded: () => void;
  /** Reports the Model selection ('' = spec default), e.g. so Retry can use it. */
  onModelChange?: (model: string) => void;
  /** Upload PDF (top bar) was pressed: open the file picker, then report it with onPicked. */
  pickPending?: boolean;
  onPicked?: () => void;
}) {
  const inputId = useId();
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [spec, setSpec] = useState('');
  const [model, setModel] = useState('');
  const [picks, setPicks] = useState<Pick[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);

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
      (list) => {
        setSpecs(list);
        const first = list.at(-1);
        if (first) setSpec(`${first.id}@${first.version}`);
      },
      (err: Error) => setLoadError(`Failed to load specs: ${err.message}`),
    );
    api.listModels().then(
      (list) => {
        setModels(list);
        // Restore the remembered model only if it can still be used; otherwise forget it.
        const saved = loadModel();
        if (!saved) return;
        if (list.some((m) => m.ref === saved && m.enabled)) {
          setModel(saved);
          onModelChange?.(saved);
        } else {
          saveModel('');
        }
      },
      () => setModels([]),
    );
    // onModelChange is a callback prop: restoring runs once per api, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  /** New files start a fresh selection once the last batch is done (failures stay to retry). */
  function add(files: readonly File[]) {
    if (!files.length) return;
    const added = files.map<Pick>((file) => ({
      key: String(nextKey.current++),
      file,
      status: isPdf(file) ? 'ready' : 'skipped',
      message: isPdf(file) ? 'Ready' : 'Not a PDF',
    }));
    setPicks((prev) => [...prev.filter(pending), ...added]);
  }

  const update = (key: string, status: Pick['status'], message: string) =>
    setPicks((prev) => prev.map((p) => (p.key === key ? { ...p, status, message } : p)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const todo = picks.filter(pending);
    if (!todo.length || !spec) return;
    const [specId, version] = spec.split('@');
    setBusy(true);
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
            <strong>Drop PDFs here</strong> or <span className="link-text">browse</span>
          </span>
          <small>Several at once — each becomes its own job</small>
        </span>
      </label>
      <input
        ref={fileInput}
        id={inputId}
        className="visually-hidden"
        type="file"
        accept="application/pdf"
        multiple
        aria-label="PDF files"
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
      <label className="field">
        Model
        <select
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            saveModel(e.target.value);
            onModelChange?.(e.target.value);
          }}
        >
          <option value="">Spec default</option>
          {models.map((m) => (
            <option key={m.ref} value={m.ref}>
              {m.displayName ?? m.modelId} — {m.provider}
            </option>
          ))}
        </select>
      </label>
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
