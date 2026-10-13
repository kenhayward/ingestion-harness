import { useEffect, useState, type FormEvent } from 'react';
import type { ProjectSummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { matchesQuery } from '../shell/derive.js';
import { ImportBundle } from './ImportBundle.js';

/** Workbench projects (one per document type) and "New project". */
export function WorkbenchPage({
  api,
  onNavigate,
  query = '',
}: {
  api: Api;
  onNavigate: (hash: string) => void;
  query?: string;
}) {
  const [items, setItems] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    api.listProjects().then(setItems, (err: Error) => setError(err.message));
  }, [api]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { project } = await api.createProject(id.trim(), name.trim() || undefined);
      onNavigate(`#/workbench/${project.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const shown = (items ?? []).filter((p) => matchesQuery(query, p.id, p.name));
  const version = (v: number | null) => (v === null ? '—' : `v${v}`);

  return (
    <section className="workbench">
      <h2>Workbench</h2>
      <p className="muted">
        Build a document type from sample PDFs: prepare their text, describe what you need, and test
        the draft on the samples.
      </p>
      {error && <p role="alert">{error}</p>}
      {items === null ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p>No projects yet.</p>
      ) : (
        <table aria-label="Projects">
          <thead>
            <tr>
              <th>Name</th>
              <th>Id</th>
              <th>Draft</th>
              <th>Published</th>
              <th>Samples</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id}>
                <td>
                  <a href={`#/workbench/${p.id}`}>{p.name}</a>
                </td>
                <td>
                  <code>{p.id}</code>
                </td>
                <td>{version(p.draft)}</td>
                <td>{version(p.published)}</td>
                <td>{p.samples}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={(e) => void create(e)} aria-label="New project" className="card">
        <h3>New project</h3>
        <label>
          Id
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. supplier-invoice"
          />
        </label>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="muted">Leave the name empty to open an existing document type.</p>
        <button type="submit" className="primary" disabled={!id.trim()}>
          Create project
        </button>
      </form>

      <ImportBundle api={api} onImported={(p) => onNavigate(`#/workbench/${p.project.id}`)} />
    </section>
  );
}
