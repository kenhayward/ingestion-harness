import { useEffect, useId, useState, type FormEvent } from 'react';
import type { Api, TemplateListItem } from '../api/client.js';
import { matchesQuery } from '../shell/derive.js';
import { Dialog } from '../ui/Dialog.js';
import { Icon } from '../ui/Icon.js';
import { TemplateCard } from './TemplateCard.js';

type Opened = { record: { id: string; version: number } };

/** Document types (UI handoff §4): a card per type, plus New and Import in dialogs. */
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
  const [dialog, setDialog] = useState<'new' | 'import' | null>(null);

  useEffect(() => {
    api.listTemplates().then(setItems, (err: Error) => setError(err.message));
  }, [api]);

  const shown = (items ?? []).filter((t) => matchesQuery(query, t.id, t.name));

  return (
    <div className="templates-page">
      <div className="page-header">
        <div>
          <h1>Document types</h1>
          <p className="muted">
            What each document looks like and what to extract. Published versions are immutable;
            edit a draft.
          </p>
        </div>
        <div className="header-actions">
          <button type="button" onClick={() => setDialog('import')}>
            <Icon name="upload" />
            Import YAML
          </button>
          <button type="button" className="primary" onClick={() => setDialog('new')}>
            <Icon name="plus" />
            New document type
          </button>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {items === null ? (
        !error && <p>Loading…</p>
      ) : items.length === 0 ? (
        <p>No document types yet.</p>
      ) : shown.length === 0 ? (
        <p>No document types match “{query.trim()}”.</p>
      ) : (
        <div className="type-grid">
          {shown.map((t) => (
            <TemplateCard key={t.id} api={api} item={t} onNavigate={onNavigate} />
          ))}
        </div>
      )}
      {dialog === 'new' && (
        <NewTypeDialog api={api} onNavigate={onNavigate} onClose={() => setDialog(null)} />
      )}
      {dialog === 'import' && (
        <ImportDialog api={api} onNavigate={onNavigate} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

/** Runs a create/import call; on success opens the resulting version, else shows the error. */
function useOpen(onNavigate: (hash: string) => void) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<Opened>) => {
    setBusy(true);
    setError(null);
    try {
      const { record } = await action();
      onNavigate(`#/templates/${record.id}/${record.version}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

function NewTypeDialog({
  api,
  onNavigate,
  onClose,
}: {
  api: Api;
  onNavigate: (hash: string) => void;
  onClose: () => void;
}) {
  const formId = useId();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const { error, busy, run } = useOpen(onNavigate);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api.createTemplate(id.trim(), name.trim()));
  };
  return (
    <Dialog
      title="New document type"
      onClose={onClose}
      actions={
        <button
          type="submit"
          form={formId}
          className="primary"
          disabled={busy || !id.trim() || !name.trim()}
        >
          Create
        </button>
      }
    >
      <form id={formId} className="dialog-form" onSubmit={submit} aria-label="New document type">
        <label>
          Id
          <input
            className="mono"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. supplier-invoice"
          />
        </label>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <p role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}

function ImportDialog({
  api,
  onNavigate,
  onClose,
}: {
  api: Api;
  onNavigate: (hash: string) => void;
  onClose: () => void;
}) {
  const formId = useId();
  const [yaml, setYaml] = useState('');
  const [publish, setPublish] = useState(false);
  const { error, busy, run } = useOpen(onNavigate);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api.importTemplate(yaml, publish));
  };
  return (
    <Dialog
      title="Import YAML"
      onClose={onClose}
      actions={
        <button type="submit" form={formId} className="primary" disabled={busy || !yaml.trim()}>
          Import
        </button>
      }
    >
      <form id={formId} className="dialog-form" onSubmit={submit} aria-label="Import YAML">
        <label>
          Template YAML
          <textarea
            className="mono"
            rows={10}
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
          />
        </label>
        <label className="inline">
          <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
          Publish if valid
        </label>
        {error && <p role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
