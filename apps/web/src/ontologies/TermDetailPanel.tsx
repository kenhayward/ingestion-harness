import { useEffect, useState } from 'react';
import type { MappingMemoryEntry, TermDetail, TermRef } from '@ih/shared';
import type { Api } from '../api/client.js';
import { TERM_KIND_LABEL } from './derive.js';

/** One term: its definition, synonyms and neighbours, each neighbour a link to its own detail. */
export function TermDetailPanel({
  api,
  ontologyId,
  version,
  iri,
  onSelect,
}: {
  api: Api;
  ontologyId: string;
  version: number;
  iri: string;
  onSelect: (iri: string) => void;
}) {
  const [term, setTerm] = useState<TermDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The remembered mappings that use this term (docs/design/mapping-memory.md). */
  const [remembered, setRemembered] = useState<MappingMemoryEntry[]>([]);
  useEffect(() => {
    let live = true;
    setRemembered([]);
    api.listMappingMemory({ status: 'all', term: iri, pageSize: 20 }).then(
      (page) => {
        if (live) setRemembered(page.entries.filter((e) => e.status !== 'rejected'));
      },
      () => {}, // advisory: the term's details stand without it
    );
    return () => {
      live = false;
    };
  }, [api, iri]);
  useEffect(() => {
    let live = true;
    setTerm(null);
    setError(null);
    api.getOntologyTerm(ontologyId, version, iri).then(
      (t) => {
        if (live) setTerm(t);
      },
      (err: Error) => {
        if (live) setError(err.message);
      },
    );
    return () => {
      live = false;
    };
  }, [api, ontologyId, version, iri]);

  return (
    <section className="term-detail" aria-label="Term details">
      {error && <p role="alert">{error}</p>}
      {!term && !error && <p>Loading…</p>}
      {term && (
        <>
          <header className="term-detail-head">
            <h2>{term.label}</h2>
            <span className="tag tone-info">{TERM_KIND_LABEL[term.kind]}</span>
            {term.deprecated && <span className="tag tone-neutral">Deprecated</span>}
            {term.definedIn && <span className="tag tone-neutral">From {term.definedIn}</span>}
          </header>
          <p className="mono term-iri">{term.iri}</p>
          {term.definition && <p>{term.definition}</p>}
          {term.altLabels.length > 0 && (
            <p className="muted">Also called: {term.altLabels.join(', ')}</p>
          )}
          <Refs
            title="Parents"
            refs={term.parentTerms}
            outside={term.parents}
            onSelect={onSelect}
          />
          <Refs title="Children" refs={term.children} onSelect={onSelect} />
          {term.schemeTerm && <Refs title="Scheme" refs={[term.schemeTerm]} onSelect={onSelect} />}
          <Refs title="Domain" refs={term.domainTerms} outside={term.domain} onSelect={onSelect} />
          <Refs title="Range" refs={term.rangeTerms} outside={term.range} onSelect={onSelect} />
          <Refs title="Properties with this domain" refs={term.asDomain} onSelect={onSelect} />
          <Refs title="Properties with this range" refs={term.asRange} onSelect={onSelect} />
          <Refs title="Concepts" refs={term.concepts} onSelect={onSelect} />
          <Refs title="Shapes targeting it" refs={term.shapes} onSelect={onSelect} />
          {remembered.length > 0 && (
            <div className="term-refs">
              <h3 id="term-remembered">Remembered for</h3>
              <ul aria-labelledby="term-remembered">
                {remembered.map((e) => (
                  <li key={e.id}>
                    {e.name} in {e.votes} recipe{e.votes === 1 ? '' : 's'}
                    {e.status === 'confirmed' ? ' (confirmed)' : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Terms of this version as buttons; IRIs outside it (imports, XSD) as plain text. */
function Refs({
  title,
  refs,
  outside = [],
  onSelect,
}: {
  title: string;
  refs: readonly TermRef[];
  outside?: readonly string[];
  onSelect: (iri: string) => void;
}) {
  const known = new Set(refs.map((r) => r.iri));
  const external = outside.filter((i) => !known.has(i));
  if (refs.length === 0 && external.length === 0) return null;
  return (
    <div className="term-refs">
      <h3>{title}</h3>
      <ul>
        {refs.map((r) => (
          <li key={r.iri}>
            <button type="button" className="link" onClick={() => onSelect(r.iri)}>
              {r.label}
            </button>
          </li>
        ))}
        {external.map((i) => (
          <li key={i} className="mono muted">
            {i}
          </li>
        ))}
      </ul>
    </div>
  );
}
