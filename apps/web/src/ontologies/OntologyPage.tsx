import type { Role } from '@ih/shared';
import { useCallback, useEffect, useState } from 'react';
import type { OntologyDetail, OntologyImport } from '@ih/shared';
import { ontologySourceUrl, type Api } from '../api/client.js';
import { navigate } from '../router.js';
import { Icon } from '../ui/Icon.js';
import { KIND_LABEL, isImporting, versionStatusText } from './derive.js';
import { DeleteVersionDialog } from './DeleteVersionDialog.js';
import { EditOntologyDialog } from './EditOntologyDialog.js';
import { VersionLine } from './OntologiesPage.js';
import type { GraphRenderer } from './graphRenderer.js';
import { TermBrowser } from './TermBrowser.js';
import { HelpButton } from '../ui/Help.js';

/** One ontology: its versions, metadata and, once a version is ready, its terms. */
export function OntologyPage({
  api,
  role,
  ontologyId,
  version: linkedVersion,
  term,
  pollMs = 2000,
  searchDelayMs = 250,
  graphRenderer,
}: {
  api: Api;
  role: Role;
  ontologyId: string;
  /** Open this version at this term (a mapping panel's *Open in Ontologies*). */
  version?: number;
  term?: string;
  pollMs?: number;
  searchDelayMs?: number;
  /** Draws term graphs (tests pass a fake: jsdom has no canvas). */
  graphRenderer?: GraphRenderer;
}) {
  const [detail, setDetail] = useState<OntologyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(linkedVersion ?? null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(
    () =>
      api.getOntology(ontologyId).then(
        (d) => {
          setDetail(d);
          setError(null);
          // Keep the chosen version while it exists; else the newest ready one, else the newest.
          setVersion((v) =>
            v !== null && d.versions.some((x) => x.version === v)
              ? v
              : (d.versions.find((x) => x.status === 'ready')?.version ??
                d.versions[0]?.version ??
                null),
          );
        },
        (err: Error) => setError(err.message),
      ),
    [api, ontologyId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const current = detail?.versions.find((v) => v.version === version) ?? null;
  const importing = current !== null && isImporting(current.status);
  useEffect(() => {
    if (!importing) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [importing, load, pollMs]);

  const deleted = () => {
    setDeleting(false);
    if (detail && detail.versions.length === 1) navigate('#/ontologies');
    else {
      setVersion(null);
      void load();
    }
  };

  return (
    <div className="ontology-page">
      <a className="back-link" href="#/ontologies">
        <Icon name="back" />
        Ontologies
      </a>
      {error && <p role="alert">{error}</p>}
      {!detail && !error && <p>Loading…</p>}
      {detail && (
        <>
          <div className="page-header">
            <div>
              <h1>{detail.label}</h1>
              <p className="mono muted">{detail.id}</p>
            </div>
            <div className="header-actions">
              {detail.versions.length > 1 && (
                <select
                  aria-label="Version"
                  value={version ?? ''}
                  onChange={(e) => setVersion(Number(e.target.value))}
                >
                  {detail.versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version} · {v.status}
                    </option>
                  ))}
                </select>
              )}
              {current?.sha256 && !current.sourceFiles && (
                <a className="button" href={ontologySourceUrl(detail.id, current.version)}>
                  <Icon name="download" />
                  Download {current.fileName}
                </a>
              )}
              {role === 'admin' && (
                <>
                  <button type="button" onClick={() => setEditing(true)}>
                    <Icon name="pencil" />
                    Edit…
                  </button>
                  {current && !importing && (
                    <button type="button" className="danger" onClick={() => setDeleting(true)}>
                      <Icon name="trash" />
                      Delete version…
                    </button>
                  )}
                </>
              )}
              <HelpButton topic="ontology" />
            </div>
          </div>
          {detail.description && <p>{detail.description}</p>}
          <div className="pills">
            {current?.kinds.map((k) => (
              <span key={k} className="tag tone-info">
                {KIND_LABEL[k]}
              </span>
            ))}
            {detail.localOnly && <span className="tag tone-warn">Local only</span>}
            {detail.retiredAt && <span className="tag tone-neutral">Retired</span>}
            {detail.tags.map((t) => (
              <span key={t} className="tag tone-neutral">
                {t}
              </span>
            ))}
          </div>
          {current && (
            <>
              <VersionLine version={current} count={detail.versions.length} />
              {importing && <p role="status">{versionStatusText(current)}</p>}
              {current.status === 'failed' && <p role="alert">{versionStatusText(current)}</p>}
              {current.imports.length > 0 && <ImportsPanel imports={current.imports} />}
              <dl className="meta ontology-meta">
                {current.ontologyIri && (
                  <>
                    <dt>Ontology IRI</dt>
                    <dd className="mono">{current.ontologyIri}</dd>
                  </>
                )}
                {current.versionIri && (
                  <>
                    <dt>Version IRI</dt>
                    <dd className="mono">{current.versionIri}</dd>
                  </>
                )}
                {current.license && (
                  <>
                    <dt>Licence</dt>
                    <dd className="mono">{current.license}</dd>
                  </>
                )}
                <dt>Source</dt>
                <dd>
                  {current.sourceUrl ? (
                    <a className="mono" href={current.sourceUrl} rel="noreferrer" target="_blank">
                      {current.sourceUrl}
                    </a>
                  ) : current.sourceFiles ? (
                    <details>
                      <summary>
                        {current.sourceFiles.length} files from {current.fileName}
                      </summary>
                      <ul className="mono" aria-label="Files of this version">
                        {current.sourceFiles.map((f) => (
                          <li key={f.fileName}>{f.fileName}</li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    'Uploaded file'
                  )}
                </dd>
                <dt>Imported</dt>
                <dd>
                  {new Date(current.importedAt).toLocaleString()}
                  {current.importedBy ? ` by ${current.importedBy}` : ''}
                </dd>
              </dl>
              {current.status === 'ready' && (
                <TermBrowser
                  key={current.version}
                  api={api}
                  ontologyId={detail.id}
                  version={current.version}
                  stats={current.stats}
                  searchDelayMs={searchDelayMs}
                  {...(term && current.version === linkedVersion ? { initialTerm: term } : {})}
                  {...(graphRenderer ? { renderer: graphRenderer } : {})}
                />
              )}
            </>
          )}
          {editing && (
            <EditOntologyDialog
              api={api}
              ontology={detail}
              onClose={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                void load();
              }}
            />
          )}
          {deleting && current && (
            <DeleteVersionDialog
              api={api}
              ontology={detail}
              version={current.version}
              versionCount={detail.versions.length}
              onClose={() => setDeleting(false)}
              onDeleted={deleted}
            />
          )}
        </>
      )}
    </div>
  );
}

/** The version's owl:imports and how each was resolved (library, fetched, or why not). */
function ImportsPanel({ imports }: { imports: readonly OntologyImport[] }) {
  const resolved = imports.filter((i) => i.resolution !== 'unresolved').length;
  return (
    <details className="ontology-imports">
      <summary>
        Imports: {resolved} resolved, {imports.length - resolved} not
      </summary>
      <ul>
        {imports.map((i) => (
          <li key={i.iri}>
            <span className="mono">{i.iri}</span>
            {' — '}
            {i.resolution === 'unresolved' ? (
              <span className="muted">{i.reason ?? 'not resolved'}</span>
            ) : i.resolution === 'included' ? (
              <span className="muted">one of this version&apos;s files</span>
            ) : (
              <>
                <a href={`#/ontologies/${encodeURIComponent(i.ontologyId ?? '')}`}>
                  {i.ontologyId} v{i.version}
                </a>
                {i.resolution === 'fetched' ? ' fetched into the library' : ' in the library'}
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
