import { useEffect, useState, type FormEvent } from 'react';
import type { ModelInfo, SpecSummary } from '@ih/shared';
import type { Api } from '../api/client.js';

export function UploadForm({
  api,
  onUploaded,
  onModelChange,
}: {
  api: Api;
  onUploaded: () => void;
  /** Reports the Model selection ('' = spec default), e.g. so Retry can use it. */
  onModelChange?: (model: string) => void;
}) {
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [spec, setSpec] = useState('');
  const [model, setModel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listSpecs().then(
      (list) => {
        setSpecs(list);
        const first = list.at(-1);
        if (first) setSpec(`${first.id}@${first.version}`);
      },
      (err: Error) => setStatus(`Failed to load specs: ${err.message}`),
    );
    api.listModels().then(setModels, () => setModels([]));
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
