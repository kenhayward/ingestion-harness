import { useCallback, useEffect, useState } from 'react';
import type { OntologySummary, OntologyVersionView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { matchesQuery } from '../shell/derive.js';
import { Icon } from '../ui/Icon.js';
import { Segmented } from '../ui/Segmented.js';
import { KIND_LABEL, isImporting, versionStatusText } from './derive.js';
import { ImportOntologyDialog } from './ImportOntologyDialog.js';

/** The ontology library's view, remembered per browser. */
const VIEW_KEY = 'ih.ontologyView';
type View = 'cards' | 'list';

function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'cards';
  } catch {
    return 'cards'; // storage blocked: default view
  }
}

function saveView(view: View): void {
  try {
    if (view === 'list') localStorage.setItem(VIEW_KEY, 'list');
    else localStorage.removeItem(VIEW_KEY);
  } catch {
    // storage blocked: the choice just isn't remembered
  }
}

/** The ontology library (ADR 0011): everyone browses, admins import. */
export function OntologiesPage({
  api,
  role,
  pollMs = 2000,
}: {
  api: Api;
  role: 'admin' | 'user';
  pollMs?: number;
}) {
  const [items, setItems] = useState<OntologySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);
  /** What the last folder import did (versions queued, files skipped). */
  const [note, setNote] = useState<string | null>(null);
  const [view, setView] = useState<View>(loadView);
  const pick = (next: View) => {
    setView(next);
    saveView(next);
  };

  const load = useCallback(
    () =>
      api.listOntologies().then(
        (list) => {
          setItems(list);
          setError(null);
        },
        (err: Error) => setError(err.message),
      ),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // Follow imports until the worker has indexed them.
  const busy = items?.some((o) => o.latest !== null && isImporting(o.latest.status)) ?? false;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [busy, load, pollMs]);

  const shown = (items ?? []).filter((o) =>
    matchesQuery(query, o.label, o.id, o.description, ...o.tags),
  );
  return (
    <div className="ontologies-page">
      <header className="ontologies-header" aria-label="Ontologies">
        <div className="ontologies-title">
          <h1>Ontologies</h1>
          <p className="muted">
            Customer and industry ontologies that document types map their outputs to.
          </p>
        </div>
        <label className="search ontologies-search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Search ontologies"
            placeholder="Search ontologies"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="ontologies-actions">
          <Segmented
            label="View"
            options={[
              { value: 'cards', label: 'Cards', icon: 'grid' },
              { value: 'list', label: 'List', icon: 'list' },
            ]}
            value={view}
            onChange={pick}
          />
          {role === 'admin' && (
            <button type="button" className="primary" onClick={() => setImporting(true)}>
              <Icon name="upload" />
              Import ontology
            </button>
          )}
        </div>
      </header>
      {note && <p role="status">{note}</p>}
      {error && <p role="alert">{error}</p>}
      {items === null && !error && <p>Loading…</p>}
      {items?.length === 0 && (
        <p className="muted">
          No ontologies yet.{role === 'admin' ? ' Import one to start.' : ' An admin imports them.'}
        </p>
      )}
      {items !== null && items.length > 0 && shown.length === 0 && (
        <p className="muted">No ontology matches “{query.trim()}”.</p>
      )}
      {shown.length > 0 &&
        (view === 'cards' ? (
          <div className="ontology-grid">
            {shown.map((o) => (
              <OntologyCard key={o.id} ontology={o} />
            ))}
          </div>
        ) : (
          <OntologyTable ontologies={shown} />
        ))}
      {importing && (
        <ImportOntologyDialog
          api={api}
          existing={items ?? []}
          onClose={() => setImporting(false)}
          onImported={(done) => {
            setImporting(false);
            setNote(done ?? null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/** What an ontology is and how it is marked: its kinds, Local only, Retired and its tags. */
function OntologyPills({ ontology: o }: { ontology: OntologySummary }) {
  return (
    <>
      {o.latest?.kinds.map((k) => (
        <span key={k} className="tag tone-info">
          {KIND_LABEL[k]}
        </span>
      ))}
      {o.localOnly && <span className="tag tone-warn">Local only</span>}
      {o.retiredAt && <span className="tag tone-neutral">Retired</span>}
      {o.tags.map((t) => (
        <span key={t} className="tag tone-neutral">
          {t}
        </span>
      ))}
    </>
  );
}

const ontologyHref = (id: string) => `#/ontologies/${encodeURIComponent(id)}`;

function OntologyCard({ ontology: o }: { ontology: OntologySummary }) {
  return (
    <section className="ontology-card" aria-label={`Ontology ${o.label}`}>
      <span className="ontology-card-icon" aria-hidden="true">
        <Icon name="graph" size={24} strokeWidth={1.8} />
      </span>
      <div className="ontology-card-body">
        <header className="ontology-card-head">
          <h2>
            <a href={ontologyHref(o.id)}>{o.label}</a>
          </h2>
          <span className="mono muted">{o.id}</span>
        </header>
        {o.description && <p className="muted">{o.description}</p>}
        <div className="pills">
          <OntologyPills ontology={o} />
        </div>
        <VersionLine version={o.latest} count={o.versionCount} />
      </div>
    </section>
  );
}

/** One row per ontology: name, id, pills, version and contents, each on one line. */
function OntologyTable({ ontologies }: { ontologies: readonly OntologySummary[] }) {
  return (
    <div className="ontology-table-wrap">
      <table className="ontology-table" aria-label="Ontologies">
        <thead>
          <tr>
            <th scope="col">Ontology</th>
            <th scope="col">Id</th>
            <th scope="col">Format and tags</th>
            <th scope="col">Version</th>
            <th scope="col">Contents</th>
          </tr>
        </thead>
        <tbody>
          {ontologies.map((o) => {
            const contents = o.latest ? versionStatusText(o.latest) : 'No versions';
            return (
              <tr key={o.id}>
                <td>
                  <a href={ontologyHref(o.id)} title={o.label}>
                    {o.label}
                  </a>
                </td>
                <td>
                  <span className="mono muted" title={o.id}>
                    {o.id}
                  </span>
                </td>
                <td>
                  <div className="pills">
                    <OntologyPills ontology={o} />
                  </div>
                </td>
                <td>
                  {o.latest ? (
                    <>
                      <span className={`pill tone-${versionTone(o.latest)}`}>
                        v{o.latest.version}
                      </span>
                      {o.versionCount > 1 && (
                        <span className="muted"> {o.versionCount} versions</span>
                      )}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <span
                    className={
                      contents === 'No terms' || contents === 'No versions' ? 'muted' : undefined
                    }
                    title={contents}
                  >
                    {contents}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const versionTone = (version: OntologyVersionView) =>
  version.status === 'failed' ? 'alert' : isImporting(version.status) ? 'info' : 'ok';

/** A version's number, status and counts (cards and the ontology page). */
export function VersionLine({
  version,
  count,
}: {
  version: OntologyVersionView | null;
  count: number;
}) {
  if (!version) return <p className="muted">No versions</p>;
  return (
    <p className="ontology-version">
      <span className={`pill tone-${versionTone(version)}`}>v{version.version}</span>{' '}
      {versionStatusText(version)}
      {count > 1 && <span className="muted"> · {count} versions</span>}
    </p>
  );
}
