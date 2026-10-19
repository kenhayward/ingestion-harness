import { useEffect, useMemo, useState } from 'react';
import { MAX_LABEL_TERMS, type Semantics, type ShaclReport, type TermLabel } from '@ih/shared';
import type { Api } from '../api/client.js';
import { EntityCard, GraphCards, resultsByEntity, type Naming } from '../rdf/GraphCards.js';
import { GraphDiagram, type GraphRenderer } from '../rdf/GraphDiagram.js';
import { curieOf, formatLiteral, humanise, parseGraph, termsOf, type RdfModel } from '../rdf/model.js';
import { HelpButton } from '../ui/Help.js';
import { Segmented } from '../ui/Segmented.js';

/** A result on a property no output publishes names the property's IRI. */
const IRI = /^[a-z][a-z0-9+.-]*:\/\//i;

const VIEWS = ['cards', 'diagram', 'turtle'] as const;
type View = (typeof VIEWS)[number];
const VIEW_KEY = 'ih.graphView';

function loadView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return (VIEWS as readonly string[]).includes(v ?? '') ? (v as View) : 'cards';
  } catch {
    return 'cards';
  }
}

function saveView(v: View): void {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    // storage unavailable: the view just isn't remembered
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What labels the graph's terms: the recipe's pins, prefixes and local terms. */
export type GraphSemantics = Pick<Semantics, 'ontologies' | 'prefixes'> &
  Partial<Pick<Semantics, 'local'>>;

/** Readable names for the model's terms, looked up once per graph (a help: IRIs are read without). */
function useLabels(api: Api, model: RdfModel | null, semantics: GraphSemantics | undefined) {
  const terms = useMemo(() => (model ? termsOf(model).slice(0, MAX_LABEL_TERMS) : []), [model]);
  const request = terms.length
    ? JSON.stringify({
        ontologies: semantics?.ontologies ?? [],
        prefixes: semantics?.prefixes ?? {},
        local: (semantics?.local ?? []).map(({ iri, label, definition }) => ({
          iri,
          label,
          ...(definition?.trim() ? { definition } : {}),
        })),
        terms,
      })
    : '';
  const [labels, setLabels] = useState<Record<string, TermLabel>>({});
  useEffect(() => {
    if (!request) return;
    let live = true;
    api.termLabels(JSON.parse(request) as Parameters<Api['termLabels']>[0]).then(
      (r) => live && setLabels(r.terms),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, request]);
  return labels;
}

/**
 * The document's graph (ADR 0011): the SHACL report of the recipe's shapes, then the graph as
 * cards (one per entity), as a diagram, or as the draft Turtle. Each result opens the output it
 * names (a field, a table or `table.column`).
 */
export function GraphTab({
  api,
  jobId,
  onOpenOutput,
  semantics,
  renderer,
}: {
  api: Api;
  jobId: string;
  onOpenOutput: (output: string) => void;
  semantics?: GraphSemantics;
  renderer?: GraphRenderer;
}) {
  const [turtle, setTurtle] = useState<string | null>(null);
  const [report, setReport] = useState<ShaclReport | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(loadView);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.getOutputText(jobId, 'graph', 'draft').then(
      (text) => live && setTurtle(text),
      (err: unknown) => live && setError((err as Error).message),
    );
    api.getShaclReport(jobId).then(
      (r) => live && setReport(r),
      (err: unknown) => live && setError((err as Error).message),
    );
    return () => {
      live = false;
    };
  }, [api, jobId]);

  const parsed = useMemo((): { model: RdfModel | null; problem: string | null } => {
    if (turtle === null) return { model: null, problem: null };
    try {
      return { model: parseGraph(turtle), problem: null };
    } catch (err) {
      return { model: null, problem: (err as Error).message };
    }
  }, [turtle]);
  const { model, problem } = parsed;
  const labels = useLabels(api, model, semantics);
  const results = useMemo(
    () => (model ? resultsByEntity(model, report?.results ?? []) : new Map()),
    [model, report],
  );
  const naming = useMemo((): Naming => {
    const term = (iri: string) => labels[iri]?.label ?? humanise(iri);
    const byIri = new Map(model?.entities.map((e) => [e.iri, e]));
    return {
      term,
      curie: (iri) => curieOf(iri, { ...model?.prefixes, ...semantics?.prefixes }),
      entity: (iri) => {
        const e = byIri.get(iri);
        if (!e) return humanise(iri);
        if (e.label) return e.label;
        return e.types[0] ? `${term(e.types[0])} ${e.key}` : e.key;
      },
    };
  }, [labels, model, semantics]);

  const change = (v: View) => {
    setView(v);
    saveView(v);
  };
  // A graph that cannot be read is still shown, as it was published.
  const shown: View = problem ? 'turtle' : view;
  const pickedEntity = model?.entities.find((e) => e.iri === picked) ?? null;
  const ended = model?.provenance?.endedAt
    ? formatLiteral({
        kind: 'literal',
        text: model.provenance.endedAt,
        datatype: 'http://www.w3.org/2001/XMLSchema#dateTime',
        lang: null,
      })
    : null;

  return (
    <div className="graph-tab">
      <section aria-labelledby="graph-shacl">
        <h3 id="graph-shacl">Shapes</h3>
        {report === undefined && !error && <p className="muted">Loading…</p>}
        {report === null && <p className="muted">No SHACL report: the recipe pins no shapes.</p>}
        {report && report.results.length === 0 && <p>The graph conforms to the shapes.</p>}
        {report && report.results.length > 0 && (
          <ul aria-label="SHACL results" className="shacl-results">
            {report.results.map((r, i) => (
              <li key={i} className={r.severity === 'Violation' ? 'field-error' : undefined}>
                <strong>{r.severity}</strong> {r.message}
                {r.value && (
                  <>
                    {' '}
                    (<code>{r.value}</code>)
                  </>
                )}{' '}
                {IRI.test(r.output) ? (
                  <code>{r.output}</code>
                ) : (
                  <button type="button" onClick={() => onOpenOutput(r.output)}>
                    Show {r.output}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {error && <p role="alert">{error}</p>}
      <section aria-labelledby="graph-turtle" className="graph-view">
        <div className="graph-view-head">
          <h3 id="graph-turtle">Graph</h3>
          {turtle !== null && (
            <Segmented
              label="Graph view"
              options={[
                { value: 'cards', label: 'Cards', icon: 'grid' },
                { value: 'diagram', label: 'Diagram', icon: 'graph' },
                { value: 'turtle', label: 'Turtle', icon: 'code' },
              ]}
              value={shown}
              onChange={change}
            />
          )}
          {model && (
            <span className="muted graph-view-count">
              {model.entities.length === 1 ? '1 entity' : `${model.entities.length} entities`} ·{' '}
              {plural(model.triples, 'triple')}
            </span>
          )}
          <HelpButton topic="reviewGraph" />
        </div>
        {model?.provenance && (
          <p className="muted graph-provenance">
            {[
              model.provenance.recipe &&
                `Recipe ${model.provenance.recipe}${model.provenance.recipeVersion ? ` v${model.provenance.recipeVersion}` : ''}`,
              ended && `extracted ${ended}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
        {problem && (
          <p role="alert">This graph could not be read, so it is shown as Turtle: {problem}</p>
        )}
        {model && shown === 'cards' && (
          <GraphCards
            model={model}
            naming={naming}
            results={results}
            onOpenOutput={onOpenOutput}
          />
        )}
        {model && shown === 'diagram' && (
          <div className="rdf-diagram-view">
            <GraphDiagram
              model={model}
              naming={naming}
              results={results}
              onSelect={setPicked}
              {...(renderer ? { renderer } : {})}
            />
            <div className="rdf-diagram-side">
              {pickedEntity ? (
                <EntityCard
                  entity={pickedEntity}
                  naming={naming}
                  results={results.get(pickedEntity.iri)}
                  onGo={setPicked}
                  onOpenOutput={onOpenOutput}
                />
              ) : (
                <p className="muted">Pick an entity in the diagram to see its card.</p>
              )}
              <ul className="rdf-entity-list" aria-label="Entities">
                {model.entities.map((e) => (
                  <li key={e.iri}>
                    <button
                      type="button"
                      className="link"
                      aria-current={e.iri === picked || undefined}
                      onClick={() => setPicked(e.iri)}
                    >
                      {naming.entity(e.iri)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {turtle !== null && shown === 'turtle' && <pre className="turtle">{turtle}</pre>}
      </section>
    </div>
  );
}
