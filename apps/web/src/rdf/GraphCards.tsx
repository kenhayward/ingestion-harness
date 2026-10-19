import type { ShaclResult } from '@ih/shared';
import {
  formatLiteral,
  type RdfEntity,
  type RdfEvidence,
  type RdfModel,
  type RdfValue,
} from './model.js';

/** A SHACL result's output that is an IRI names a property no output publishes. */
const IRI = /^[a-z][a-z0-9+.-]*:\/\//i;

/** How the cards and the diagram name things: terms by their label, entities by theirs. */
export interface Naming {
  /** A term (type, property, concept, unit): its ontology label, else read from its IRI. */
  term: (iri: string) => string;
  /** A term as written (`acme:sentBy`), for a tooltip. */
  curie: (iri: string) => string;
  /** An entity of the graph: its label, else its type and key ("Line AB-1"). */
  entity: (iri: string) => string;
}

/** SHACL results by the entity and property they are about (see `resultsByEntity`). */
export type EntityResults = Map<string, Map<string, ShaclResult[]>>;

/**
 * Files each result under the entity and property it is about: a result on a value node goes
 * to the property holding the node, one on an entity to its path. Results on nodes this graph
 * does not show are left to the Shapes list.
 */
export function resultsByEntity(model: RdfModel, results: readonly ShaclResult[]): EntityResults {
  const out: EntityResults = new Map();
  for (const r of results) {
    const owner = model.ownerOf(r.focus);
    if (!owner) continue;
    const predicate = owner.predicate ?? r.path;
    if (!predicate) continue;
    const byPredicate = out.get(owner.entity) ?? new Map<string, ShaclResult[]>();
    byPredicate.set(predicate, [...(byPredicate.get(predicate) ?? []), r]);
    out.set(owner.entity, byPredicate);
  }
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function evidenceText(e: RdfEvidence, withSection: boolean): string | null {
  const parts: string[] = [];
  if (e.pages.length) parts.push(`${e.pages.length > 1 ? 'pp.' : 'p.'} ${e.pages.join(', ')}`);
  if (withSection && e.section) parts.push(`${e.section} section`);
  if (e.quote) parts.push(`“${e.quote}”`);
  return parts.length ? parts.join(' · ') : null;
}

function Value({
  value,
  naming,
  onGo,
}: {
  value: RdfValue;
  naming: Naming;
  onGo: (iri: string) => void;
}) {
  switch (value.kind) {
    case 'literal':
      return (
        <span className="rdf-literal">
          {formatLiteral(value)}
          {value.lang && <span className="rdf-lang">{value.lang}</span>}
        </span>
      );
    case 'entity':
      return (
        <button type="button" className="rdf-link" onClick={() => onGo(value.iri)}>
          {naming.entity(value.iri)}
        </button>
      );
    case 'term':
      return (
        <span className="rdf-term" title={naming.curie(value.iri)}>
          {naming.term(value.iri)}
        </span>
      );
    case 'node': {
      const held =
        value.value === null
          ? '—'
          : value.value.kind === 'literal'
            ? formatLiteral(value.value)
            : naming.term(value.value.iri);
      return (
        <span className="rdf-literal" title={value.types.map(naming.curie).join(', ')}>
          {held}
          {value.unit && (
            <span className="rdf-unit" title={naming.curie(value.unit)}>
              {' '}
              {naming.term(value.unit)}
            </span>
          )}
        </span>
      );
    }
  }
}

function Results({
  results,
  onOpenOutput,
}: {
  results: readonly ShaclResult[];
  onOpenOutput: ((output: string) => void) | undefined;
}) {
  return (
    <ul className="rdf-results">
      {results.map((r, i) => (
        <li key={i}>
          <strong>{r.severity}</strong> {r.message}{' '}
          {onOpenOutput && !IRI.test(r.output) && (
            <button type="button" className="link" onClick={() => onOpenOutput(r.output)}>
              Show {r.output}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

const severityClass = (results: readonly ShaclResult[] | undefined) =>
  !results?.length
    ? 'rdf-row'
    : results.some((r) => r.severity === 'Violation')
      ? 'rdf-row rdf-row-violation'
      : 'rdf-row rdf-row-warning';

/** One entity: its type, its properties with their evidence and results, who links to it. */
export function EntityCard({
  entity,
  naming,
  results,
  onGo,
  onOpenOutput,
}: {
  entity: RdfEntity;
  naming: Naming;
  results: Map<string, ShaclResult[]> | undefined;
  onGo: (iri: string) => void;
  /** Lets a result open its output; none where there is nothing to open. */
  onOpenOutput?: (output: string) => void;
}) {
  const headingId = `rdf-${entity.iri}`;
  const all = [...(results?.values() ?? [])].flat();
  const violations = all.filter((r) => r.severity === 'Violation').length;
  const warnings = all.filter((r) => r.severity === 'Warning').length;
  const notes = all.length - violations - warnings;
  const shown = new Set(entity.properties.map((p) => p.predicate));
  const missing = [...(results?.entries() ?? [])].filter(([p]) => !shown.has(p));
  const rowEvidence = entity.evidence && evidenceText(entity.evidence, true);
  return (
    <article
      className={`rdf-card${entity.root ? ' rdf-card-root' : ''}${violations ? ' rdf-card-violation' : ''}`}
      aria-labelledby={headingId}
      data-iri={entity.iri}
      tabIndex={-1}
    >
      <header className="rdf-card-head">
        <h4 id={headingId}>{naming.entity(entity.iri)}</h4>
        {entity.types.map((t) => (
          <span key={t} className="rdf-type" title={naming.curie(t)}>
            {naming.term(t)}
          </span>
        ))}
        {entity.root && <span className="rdf-type rdf-type-root">Document</span>}
        {all.length > 0 && (
          <span className={violations ? 'rdf-flag rdf-flag-violation' : 'rdf-flag'}>
            {[
              violations ? plural(violations, 'violation') : '',
              warnings ? plural(warnings, 'warning') : '',
              notes ? plural(notes, 'note') : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </header>
      {rowEvidence && <p className="rdf-evidence">{rowEvidence}</p>}
      {entity.properties.length + missing.length > 0 && (
        <table className="rdf-props">
          <tbody>
            {entity.properties.map((p) => {
              const r = results?.get(p.predicate);
              const ev = p.evidence && evidenceText(p.evidence, false);
              return (
                <tr key={p.predicate} className={severityClass(r)}>
                  <th scope="row" title={naming.curie(p.predicate)}>
                    {naming.term(p.predicate)}
                  </th>
                  <td>
                    <span className="rdf-values">
                      {p.values.map((v, i) => (
                        <Value key={i} value={v} naming={naming} onGo={onGo} />
                      ))}
                    </span>
                    {ev && <span className="rdf-evidence">{ev}</span>}
                    {r && <Results results={r} onOpenOutput={onOpenOutput} />}
                  </td>
                </tr>
              );
            })}
            {missing.map(([p, r]) => (
              <tr key={p} className={severityClass(r)}>
                <th scope="row" title={naming.curie(p)}>
                  {naming.term(p)}
                </th>
                <td>
                  <span className="rdf-missing">Missing</span>
                  <Results results={r} onOpenOutput={onOpenOutput} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {entity.incoming.length > 0 && (
        <p className="rdf-incoming">
          Linked from{' '}
          {entity.incoming.map((l, i) => (
            <span key={`${l.from}|${l.predicate}`}>
              {i > 0 && ', '}
              <button type="button" className="rdf-link" onClick={() => onGo(l.from)}>
                {naming.entity(l.from)}
              </button>{' '}
              <span className="muted">({naming.term(l.predicate).toLowerCase()})</span>
            </span>
          ))}
        </p>
      )}
    </article>
  );
}

/** Every entity as a card, the document first; links move focus to the card they name. */
export function GraphCards({
  model,
  naming,
  results,
  onOpenOutput,
}: {
  model: RdfModel;
  naming: Naming;
  results: EntityResults;
  onOpenOutput?: (output: string) => void;
}) {
  const go = (iri: string) => {
    const card = [...document.querySelectorAll<HTMLElement>('.rdf-card')].find(
      (el) => el.dataset.iri === iri,
    );
    if (!card) return;
    card.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    card.focus();
  };
  if (!model.entities.length) return <p className="muted">The graph describes no entities.</p>;
  return (
    <div className="rdf-cards">
      {model.entities.map((e) => (
        <EntityCard
          key={e.iri}
          entity={e}
          naming={naming}
          results={results.get(e.iri)}
          onGo={go}
          {...(onOpenOutput ? { onOpenOutput } : {})}
        />
      ))}
    </div>
  );
}
