import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { SpecSummary } from '@ih/shared';
import type { Api, TemplateListItem } from '../api/client.js';
import { matchesQuery } from '../shell/derive.js';
import { Dialog } from '../ui/Dialog.js';
import { Icon } from '../ui/Icon.js';
import { unretireHint } from '../ui/retired.js';
import { LegacyTypeCard } from './LegacyTypeCard.js';
import { legacyTypes } from './legacy.js';
import { RetireDialog } from './RetireDialog.js';
import { TemplateCard } from './TemplateCard.js';

type Opened = { record: { id: string; version: number } };

/**
 * Document types (UI handoff §4): a card per database recipe and per legacy file-only spec
 * (D16), plus New and Import in dialogs. Retired types are not shown (D15).
 */
export function TemplatesPage({
  api,
  onNavigate,
  query = '',
  role = 'user',
}: {
  api: Api;
  onNavigate: (hash: string) => void;
  /** Top-bar search: shows only matching document types. */
  query?: string;
  /** Admins get Retire… on every card. */
  role?: 'admin' | 'user';
}) {
  const [items, setItems] = useState<TemplateListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'new' | 'import' | null>(null);

  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  /** The card whose Retire… confirm is open. */
  const [retiring, setRetiring] = useState<{ id: string; name: string } | null>(null);
  /** Said after a retire, since the card leaves the page. */
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.listTemplates().then(setItems, (err: Error) => setError(err.message));
    // Legacy cards (D16); GET /api/specs leaves retired types out. Optional: no error shown.
    api.listSpecs().then(setSpecs, () => setSpecs([]));
  }, [api]);
  useEffect(reload, [reload]);

  // Retired types are not shown here at all (D15); unretiring is API-only (D14).
  const active = (items ?? []).filter((t) => !t.retired);
  const legacy = items === null ? [] : legacyTypes(specs, new Set(items.map((t) => t.id)));
  const shown = active.filter((t) => matchesQuery(query, t.id, t.name));
  const shownLegacy = legacy.filter((l) => matchesQuery(query, l.id, l.title));
  const retire = (id: string, name: string) =>
    role === 'admin'
      ? () => {
          setNotice(null);
          setRetiring({ id, name });
        }
      : undefined;

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
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
      {items === null ? (
        !error && <p>Loading…</p>
      ) : active.length + legacy.length === 0 ? (
        <p>No document types yet.</p>
      ) : shown.length + shownLegacy.length === 0 ? (
        <p>No document types match “{query.trim()}”.</p>
      ) : (
        <div className="type-grid">
          {shown.map((t) => (
            <TemplateCard
              key={t.id}
              api={api}
              item={t}
              onNavigate={onNavigate}
              onRetire={retire(t.id, t.name)}
            />
          ))}
          {shownLegacy.map((l) => (
            <LegacyTypeCard key={l.id} item={l} onRetire={retire(l.id, l.title)} />
          ))}
        </div>
      )}
      {retiring && (
        <RetireDialog
          api={api}
          id={retiring.id}
          name={retiring.name}
          onClose={() => setRetiring(null)}
          onRetired={() => {
            setNotice(`${retiring.name} is retired. ${unretireHint(retiring.id)}`);
            setRetiring(null);
            reload();
          }}
        />
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
          Recipe YAML
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
