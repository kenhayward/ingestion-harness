import { useEffect, useState, type FormEvent } from 'react';
import type { Api, TemplateListItem } from '../api/client.js';
import { matchesQuery } from '../shell/derive.js';

export function TemplatesPage({
  api,
  onNavigate,
  query = '',
}: {
  api: Api;
  onNavigate: (hash: string) => void;
  /** Top-bar search: shows only matching document types. */
  query?: string;
}) {
  const [items, setItems] = useState<TemplateListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [yaml, setYaml] = useState('');
  const [publish, setPublish] = useState(false);

  useEffect(() => {
    api.listTemplates().then(setItems, (err: Error) => setError(err.message));
  }, [api]);

  const run = async (action: () => Promise<{ record: { id: string; version: number } }>) => {
    try {
      const { record } = await action();
      onNavigate(`#/templates/${record.id}/${record.version}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api.createTemplate(id.trim(), name.trim()));
  };
  const importYaml = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api.importTemplate(yaml, publish));
  };

  const shown = (items ?? []).filter((t) => matchesQuery(query, t.id, t.name));

  return (
    <section className="templates">
      <h2>Document types</h2>
      {error && <p role="alert">{error}</p>}
      {items === null ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p>No document types yet.</p>
      ) : shown.length === 0 ? (
        <p>No document types match “{query.trim()}”.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Id</th>
              <th>Published</th>
              <th>Draft</th>
              <th>Workbench</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>
                  <code>{t.id}</code>
                </td>
                <td>
                  {t.published !== null ? (
                    <a href={`#/templates/${t.id}/${t.published}`}>v{t.published} (published)</a>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  {t.draft !== null ? (
                    <a href={`#/templates/${t.id}/${t.draft}`}>v{t.draft} (draft)</a>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <a href={`#/workbench/${t.id}`}>Open in workbench</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="template-actions">
        <form onSubmit={create} aria-label="New document type">
          <h3>New document type</h3>
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
          <button type="submit" disabled={!id.trim() || !name.trim()}>
            Create
          </button>
        </form>

        <form onSubmit={importYaml} aria-label="Import template">
          <h3>Import</h3>
          <label>
            Template YAML
            <textarea rows={6} value={yaml} onChange={(e) => setYaml(e.target.value)} />
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={publish}
              onChange={(e) => setPublish(e.target.checked)}
            />
            Publish if valid
          </label>
          <button type="submit" disabled={!yaml.trim()}>
            Import
          </button>
        </form>
      </div>
    </section>
  );
}
