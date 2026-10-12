import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ModelInfo, SpecSummary } from '@ih/shared';
import type { Api } from '../api/client.js';

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

export function UploadForm({
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
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [spec, setSpec] = useState('');
  const [model, setModel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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
      (err: Error) => setStatus(`Failed to load specs: ${err.message}`),
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

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file || !spec) return;
    const [specId, version] = spec.split('@');
    setBusy(true);
    try {
      const job = await api.upload({
        file,
        specId: specId!,
        specVersion: Number(version),
        model: model || undefined,
      });
      setStatus(`Queued job ${job.id}`);
      onUploaded();
    } catch (err) {
      setStatus(`Upload failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Upload document">
      <label>
        Document type
        <select value={spec} onChange={(e) => setSpec(e.target.value)}>
          {specs.map((s) => (
            <option key={`${s.id}@${s.version}`} value={`${s.id}@${s.version}`}>
              {s.title} (v{s.version})
            </option>
          ))}
        </select>
      </label>
      <label>
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
      <label>
        PDF
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <button type="submit" disabled={!file || !spec || busy}>
        Upload
      </button>
      {status && <p role="status">{status}</p>}
    </form>
  );
}
