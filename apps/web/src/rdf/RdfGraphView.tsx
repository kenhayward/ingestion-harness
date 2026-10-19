import { useEffect, useId, useMemo, useState } from 'react';
import { MAX_LABEL_TERMS, type Semantics, type ShaclReport, type TermLabel } from '@ih/shared';
import type { Api } from '../api/client.js';
import { HelpButton } from '../ui/Help.js';
import { Segmented } from '../ui/Segmented.js';
import { EntityCard, GraphCards, resultsByEntity, type Naming } from './GraphCards.js';
import { GraphDiagram, type GraphRenderer } from './GraphDiagram.js';
import { curieOf, formatLiteral, humanise, parseGraph, termsOf, type RdfModel } from './model.js';

const VIEWS = ['cards', 'diagram', 'turtle'] as const;
type View = (typeof VIEWS)[number];
/** One choice for every graph: Review, the mapping preview and published results. */
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
 * A document graph (ADR 0011) three ways: cards (one per entity, the document first), a diagram
 * of the entities and their links, or the Turtle as published. The SHACL `report`, when given,
 * marks the rows and nodes its results are about; `onOpenOutput` lets a result open its output.
 */
export function RdfGraphView({
  api,
  turtle,
  report,
  semantics,
  onOpenOutput,
  renderer,
  title,
}: {
  api: Api;
  turtle: string;
  report?: ShaclReport | null;
  semantics?: GraphSemantics | undefined;
  onOpenOutput?: (output: string) => void;
  renderer?: GraphRenderer;
  /** A heading of its own ("Graph"); none where the caller already names the graph. */
  title?: string;
}) {
  const headingId = useId();
  const [view, setView] = useState<View>(loadView);
  const [picked, setPicked] = useState<string | null>(null);

  const parsed = useMemo((): { model: RdfModel | null; problem: string | null } => {
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
    <section className="graph-view" {...(title ? { 'aria-labelledby': headingId } : {})}>
      <div className="graph-view-head">
        {title && <h3 id={headingId}>{title}</h3>}
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
        {model && (
          <span className="muted graph-view-count">
            {model.entities.length === 1 ? '1 entity' : `${model.entities.length} entities`} ·{' '}
            {plural(model.triples, 'triple')}
          </span>
        )}
        <HelpButton topic="graphViews" />
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
          {...(onOpenOutput ? { onOpenOutput } : {})}
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
                {...(onOpenOutput ? { onOpenOutput } : {})}
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
      {shown === 'turtle' && <pre className="turtle">{turtle}</pre>}
    </section>
  );
}
