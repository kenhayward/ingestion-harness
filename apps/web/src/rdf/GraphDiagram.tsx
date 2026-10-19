import { useEffect, useMemo, useRef } from 'react';
import { textMeasurer } from '../ontologies/graphRenderer.js';
import type { EntityResults, Naming } from './GraphCards.js';
import type { RdfModel } from './model.js';

export interface DiagramNode {
  id: string;
  label: string;
  root: boolean;
  /** `violation` when a SHACL violation is about it, `result` for other results. */
  flag: 'violation' | 'result' | null;
}
export interface DiagramEdge {
  source: string;
  target: string;
  label: string;
}
export interface DiagramData {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** Draws the diagram into `el`; returns the cleanup. Tests pass a fake. */
export type GraphRenderer = (
  el: HTMLElement,
  data: DiagramData,
  onSelect: (iri: string) => void,
) => () => void;

/** The entities as nodes (their values stay in their cards), their links as edges. */
export function diagramData(model: RdfModel, naming: Naming, results: EntityResults): DiagramData {
  const nodes = model.entities.map((e): DiagramNode => {
    const all = [...(results.get(e.iri)?.values() ?? [])].flat();
    return {
      id: e.iri,
      label: naming.entity(e.iri),
      root: e.root,
      flag: all.some((r) => r.severity === 'Violation')
        ? 'violation'
        : all.length
          ? 'result'
          : null,
    };
  });
  const seen = new Set<string>();
  const edges: DiagramEdge[] = [];
  for (const e of model.entities)
    for (const p of e.properties)
      for (const v of p.values) {
        if (v.kind !== 'entity') continue;
        const key = `${e.iri}|${p.predicate}|${v.iri}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: e.iri, target: v.iri, label: naming.term(p.predicate) });
      }
  return { nodes, edges };
}

const FONT_SIZE = 12;
let registered = false;

/** Cytoscape.js, loaded when a diagram is first shown, laid out breadth first from the document. */
export const cytoscapeDiagram: GraphRenderer = (el, data, onSelect) => {
  let gone = false;
  let destroy = () => {};
  void Promise.all([import('cytoscape'), import('cytoscape-fcose')]).then(
    ([cyModule, fcoseModule]) => {
      if (gone) return;
      const cytoscape = cyModule.default;
      if (!registered) {
        cytoscape.use(fcoseModule.default);
        registered = true;
      }
      // Colours come from the theme tokens, so the diagram follows light and dark.
      const css = getComputedStyle(el);
      const token = (name: string, fallback: string) =>
        css.getPropertyValue(name).trim() || fallback;
      const line = token('--ih-border-strong', '#8a8f98');
      const fontFamily = css.fontFamily || 'sans-serif';
      const measure = textMeasurer(`${FONT_SIZE}px ${fontFamily}`);
      const roots = data.nodes.filter((n) => n.root).map((n) => n.id);
      // A tree reads best for a document and its rows; anything with cycles or several
      // unlinked parts gets the force layout.
      const tree = roots.length === 1 && data.edges.length < data.nodes.length;
      const cy = cytoscape({
        container: el,
        elements: [
          ...data.nodes.map((n) => ({
            data: {
              id: n.id,
              label: n.label,
              root: n.root ? 1 : 0,
              flag: n.flag ?? '',
              w: Math.max(24, Math.ceil(measure(n.label))),
            },
          })),
          ...data.edges.map((e) => ({
            data: {
              id: `${e.source}|${e.label}|${e.target}`,
              source: e.source,
              target: e.target,
              label: e.label,
            },
          })),
        ],
        style: [
          {
            selector: 'node',
            style: {
              label: 'data(label)',
              'font-size': FONT_SIZE,
              'font-family': fontFamily,
              color: token('--ih-text', '#1d2129'),
              'background-color': token('--ih-surface', '#ffffff'),
              'border-width': 1,
              'border-color': line,
              'text-valign': 'center',
              'text-halign': 'center',
              width: 'data(w)',
              height: 30,
              padding: '10px',
              shape: 'round-rectangle',
            },
          },
          {
            selector: 'node[root = 1]',
            style: {
              'background-color': token('--ih-accent', '#2f5bd3'),
              color: token('--ih-accent-text', '#ffffff'),
              'border-width': 0,
            },
          },
          {
            selector: 'node[flag = "result"]',
            style: { 'border-color': token('--ih-warn-fg', '#9a6700'), 'border-width': 2 },
          },
          {
            // A border only: the document's node keeps its accent fill and readable label.
            selector: 'node[flag = "violation"]',
            style: { 'border-color': token('--ih-danger-fg', '#c62828'), 'border-width': 3 },
          },
          {
            selector: 'node:selected',
            style: { 'border-color': token('--ih-accent', '#2f5bd3'), 'border-width': 3 },
          },
          {
            selector: 'edge',
            style: {
              label: 'data(label)',
              'font-size': 10,
              color: token('--ih-muted', '#5f6672'),
              'text-background-color': token('--ih-surface', '#ffffff'),
              'text-background-opacity': 1,
              'text-background-padding': '2px',
              width: 1,
              'line-color': line,
              'target-arrow-shape': 'triangle',
              'target-arrow-color': line,
              'curve-style': 'bezier',
            },
          },
        ],
        layout: (tree
          ? { name: 'breadthfirst', directed: true, roots, spacingFactor: 1.4, animate: false }
          : { name: 'fcose', animate: false, idealEdgeLength: 120 }) as unknown as {
          name: string;
        },
        wheelSensitivity: 0.2,
      });
      cy.on('tap', 'node', (ev) => onSelect(String(ev.target.id())));
      destroy = () => cy.destroy();
    },
    // The cards show everything the diagram does; the canvas is a convenience.
    (err: unknown) => console.warn('the graph diagram could not be drawn', err),
  );
  return () => {
    gone = true;
    destroy();
  };
};

/** The diagram's canvas; picking a node calls `onSelect` with its IRI. */
export function GraphDiagram({
  model,
  naming,
  results,
  onSelect,
  renderer = cytoscapeDiagram,
}: {
  model: RdfModel;
  naming: Naming;
  results: EntityResults;
  onSelect: (iri: string) => void;
  renderer?: GraphRenderer;
}) {
  const canvas = useRef<HTMLDivElement | null>(null);
  const data = useMemo(() => diagramData(model, naming, results), [model, naming, results]);
  // Re-draw only when what is drawn changes, not on every render of the tab.
  const key = JSON.stringify(data);
  const select = useRef(onSelect);
  select.current = onSelect;
  useEffect(() => {
    if (!canvas.current) return;
    return renderer(canvas.current, JSON.parse(key) as DiagramData, (iri) => select.current(iri));
  }, [key, renderer]);
  return <div className="rdf-diagram" ref={canvas} aria-hidden="true" />;
}
