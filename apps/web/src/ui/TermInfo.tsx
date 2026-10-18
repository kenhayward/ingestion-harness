import { useState } from 'react';
import type { TermLabel } from '@ih/shared';

/** Definitions longer than this fold behind More. */
const LONG = 160;

/** The ontology browser at the version holding the term (`<id>@<version>`), open at it. */
export function termHref(definedIn: string, iri: string): string {
  const [id, version] = definedIn.split('@');
  return `#/ontologies/${encodeURIComponent(id ?? '')}/${version ?? ''}/${encodeURIComponent(iri)}`;
}

/**
 * What a mapped term means, so a reviewer can judge it without opening the ontology: its name,
 * synonyms and definition, where it comes from, and a link to it in the ontology browser.
 */
export function TermInfo({ info }: { info: TermLabel }) {
  const [open, setOpen] = useState(false);
  const definition = info.definition?.trim() ?? '';
  const long = definition.length > LONG;
  return (
    <div className="term-info">
      <div className="term-info-head">
        <strong className="term-label">{info.label || 'No label'}</strong>
        <span className="term-from">
          {info.from === 'local' ? 'local term' : (info.ontology ?? '').replace('@', ' v')}
        </span>
        {info.deprecated && <span className="kind-tag tone-warn">deprecated</span>}
      </div>
      {info.altLabels.length > 0 && (
        <p className="term-info-syn">Also called: {info.altLabels.join(', ')}</p>
      )}
      {definition ? (
        <p className={long && !open ? 'term-info-def clamped' : 'term-info-def'}>
          {definition}
          {long && (
            <>
              {' '}
              <button
                type="button"
                className="link"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
              >
                {open ? 'Less' : 'More'}
              </button>
            </>
          )}
        </p>
      ) : (
        <p className="term-info-def muted">No definition</p>
      )}
      {info.from === 'ontology' && info.ontology && info.iri && (
        <a className="term-info-link" href={termHref(info.ontology, info.iri)}>
          Open in Ontologies
        </a>
      )}
    </div>
  );
}
