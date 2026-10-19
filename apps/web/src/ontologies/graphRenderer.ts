import type { Neighbourhood } from '@ih/shared';

/** Draws a neighbourhood into `el`; returns the cleanup. Tests pass a fake. */
export type GraphRenderer = (
  el: HTMLElement,
  data: Neighbourhood,
  onSelect: (iri: string) => void,
) => () => void;

const EDGE_LABEL: Record<string, string> = {
  subClassOf: 'subclass of',
  subPropertyOf: 'subproperty of',
  broader: 'broader',
  inScheme: 'in scheme',
  domain: 'domain',
  range: 'range',
  targets: 'targets',
};

/** The narrowest a node's label box gets (its padding is added on top). */
const MIN_LABEL_WIDTH = 12;
const FONT_SIZE = 11;

/**
 * Cytoscape's elements for a neighbourhood. Each node carries `w`, its label's measured width:
 * with `width: 'label'` Cytoscape hides every bezier edge and lays nodes out before their labels
 * are measured, so they overlap.
 */
export function graphElements(data: Neighbourhood, measure: (text: string) => number) {
  return [
    ...data.nodes.map((n) => ({
      data: {
        id: n.iri,
        label: n.label,
        kind: n.kind,
        focus: n.focus ? 1 : 0,
        w: Math.max(MIN_LABEL_WIDTH, Math.ceil(measure(n.label))),
      },
    })),
    ...data.edges.map((e) => ({
      data: {
        id: `${e.source}|${e.kind}|${e.target}`,
        source: e.source,
        target: e.target,
        label: EDGE_LABEL[e.kind] ?? e.kind,
      },
    })),
  ];
}

/** Measures text in `font` with a canvas; a rough estimate where there is none. */
export function textMeasurer(font: string): (text: string) => number {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return (text) => text.length * FONT_SIZE * 0.6;
  ctx.font = font;
  return (text) => ctx.measureText(text).width;
}

let registered = false;

/** Cytoscape.js with the fcose layout, loaded only when a graph is first shown. */
export const cytoscapeRenderer: GraphRenderer = (el, data, onSelect) => {
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
      // Colours come from the theme tokens, so the graph follows light and dark.
      const css = getComputedStyle(el);
      const token = (name: string, fallback: string) =>
        css.getPropertyValue(name).trim() || fallback;
      const line = token('--ih-border-strong', '#8a8f98');
      // Nodes are drawn and measured in the page's font, so a label fits its box.
      const fontFamily = css.fontFamily || 'sans-serif';
      const cy = cytoscape({
        container: el,
        elements: graphElements(data, textMeasurer(`${FONT_SIZE}px ${fontFamily}`)),
        style: [
          {
            selector: 'node',
            style: {
              label: 'data(label)',
              'font-size': FONT_SIZE,
              'font-family': fontFamily,
              color: token('--ih-text', '#1d2129'),
              'background-color': token('--ih-info-bg', '#dbe7fb'),
              'border-width': 1,
              'border-color': line,
              'text-valign': 'center',
              'text-halign': 'center',
              width: 'data(w)',
              height: 24,
              padding: '6px',
              shape: 'round-rectangle',
            },
          },
          {
            selector: 'node[kind = "external"]',
            style: {
              'background-color': token('--ih-surface2', '#eef0f3'),
              'border-style': 'dashed',
            },
          },
          {
            selector: 'node[focus = 1]',
            style: {
              'background-color': token('--ih-accent', '#2f5bd3'),
              color: token('--ih-accent-text', '#ffffff'),
            },
          },
          {
            selector: 'edge',
            style: {
              label: 'data(label)',
              'font-size': 9,
              color: token('--ih-muted', '#5f6672'),
              width: 1,
              'line-color': line,
              'target-arrow-shape': 'triangle',
              'target-arrow-color': line,
              'curve-style': 'bezier',
            },
          },
        ],
        // Room between nodes for the edge labels.
        layout: { name: 'fcose', animate: false, idealEdgeLength: 90 } as unknown as {
          name: string;
        },
      });
      cy.on('tap', 'node', (ev) => onSelect(String(ev.target.id())));
      destroy = () => cy.destroy();
    },
    // The list beside the graph still shows every link; the canvas is a convenience.
    (err: unknown) => console.warn('the term graph could not be drawn', err),
  );
  return () => {
    gone = true;
    destroy();
  };
};
