import { useCallback, useEffect, useState } from 'react';
import type { OntologySummary, OntologyVersionView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { matchesQuery } from '../shell/derive.js';
import { Icon } from '../ui/Icon.js';
import { KIND_LABEL, isImporting, versionStatusText } from './derive.js';
import { ImportOntologyDialog } from './ImportOntologyDialog.js';

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
      <div className="page-header">
        <div>
          <h1>Ontologies</h1>
          <p className="muted">
            Customer and industry ontologies that document types map their outputs to.
          </p>
        </div>
        {role === 'admin' && (
          <button type="button" className="primary" onClick={() => setImporting(true)}>
            <Icon name="upload" />
            Import ontology
          </button>
        )}
      </div>
      <label className="search">
        <Icon name="search" />
        <input
          type="search"
          aria-label="Search ontologies"
          placeholder="Search ontologies"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {note && <p role="status">{note}</p>}
      {error && <p role="alert">{error}</p>}
      {items === null && !error && <p>Loading…</p>}
      {items?.length === 0 && (
        <p className="muted">
          No ontologies yet.{role === 'admin' ? ' Import one to start.' : ' An admin imports them.'}
        </p>
      )}
      <div className="type-grid">
        {shown.map((o) => (
          <OntologyCard key={o.id} ontology={o} />
        ))}
      </div>
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

function OntologyCard({ ontology: o }: { ontology: OntologySummary }) {
  return (
    <section className="ontology-card" aria-label={`Ontology ${o.label}`}>
      <header className="ontology-card-head">
        <h2>
          <a href={`#/ontologies/${encodeURIComponent(o.id)}`}>{o.label}</a>
        </h2>
        <span className="mono muted">{o.id}</span>
      </header>
      {o.description && <p className="muted">{o.description}</p>}
      <div className="pills">
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
      </div>
      <VersionLine version={o.latest} count={o.versionCount} />
    </section>
  );
}

/** A version's number, status and counts (cards and the ontology page). */
export function VersionLine({
  version,
  count,
}: {
  version: OntologyVersionView | null;
  count: number;
}) {
  if (!version) return <p className="muted">No versions</p>;
  const tone = version.status === 'failed' ? 'alert' : isImporting(version.status) ? 'info' : 'ok';
  return (
    <p className="ontology-version">
      <span className={`pill tone-${tone}`}>v{version.version}</span> {versionStatusText(version)}
      {count > 1 && <span className="muted"> · {count} versions</span>}
    </p>
  );
}
