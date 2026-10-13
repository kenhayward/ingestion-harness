import { useState, type FormEvent } from 'react';
import type { ProjectView } from '@ih/shared';
import type { Api } from '../api/client.js';

/** Import a drafting bundle (.zip) as a new local project; shown inside the list's dialog. */
export function ImportBundle({
  api,
  onImported,
}: {
  api: Api;
  onImported: (project: ProjectView) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [id, setId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onImported(await api.importBundle(file, id.trim() ? { id: id.trim() } : {}));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} aria-label="Import bundle">
      <p className="muted">
        Creates a local-only project with the bundle&apos;s draft, brief and dev samples.
      </p>
      <label>
        Bundle (.zip)
        <input
          type="file"
          accept=".zip,application/zip"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <label>
        Project id (optional)
        <input value={id} onChange={(e) => setId(e.target.value)} />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" className="primary" disabled={!file || busy}>
        Import
      </button>
    </form>
  );
}
