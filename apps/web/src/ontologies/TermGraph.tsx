import { useEffect, useRef, useState } from 'react';
import type { GraphEdge, Neighbourhood } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Segmented } from '../ui/Segmented.js';
import { cytoscapeRenderer, type GraphRenderer } from './graphRenderer.js';

/** How a link reads in the list beside the graph: "<source> <phrase> <target>". */
const PHRASE: Record<GraphEdge['kind'], string> = {
  subClassOf: 'is a subclass of',
  subPropertyOf: 'is a subproperty of',
  broader: 'is narrower than',
  inScheme: 'is in',
  domain: 'has domain',
  range: 'has range',
  targets: 'targets',
};

/**
 * A term's neighbourhood as a graph (drawn by `renderer`, Cytoscape by default) and, for
 * keyboard and screen-reader users, as a list of the same links.
 */
export function TermGraph({
  api,
  ontologyId,
  version,
  iri,
  onSelect,
  renderer = cytoscapeRenderer,
}: {
  api: Api;
  ontologyId: string;
  version: number;
  iri: string;
  onSelect: (iri: string) => void;
  renderer?: GraphRenderer;
}) {
  const [depth, setDepth] = useState<'1' | '2'>('1');
  const [data, setData] = useState<Neighbourhood | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api.getNeighbourhood(ontologyId, version, iri, depth === '2' ? 2 : 1).then(
      (n) => {
        if (live) setData(n);
      },
      (err: Error) => {
        if (live) setError(err.message);
      },
    );
    return () => {
      live = false;
    };
  }, [api, ontologyId, version, iri, depth]);

  useEffect(() => {
    if (!data || !canvas.current) return;
    return renderer(canvas.current, data, onSelect);
  }, [data, renderer, onSelect]);

  const byIri = new Map(data?.nodes.map((n) => [n.iri, n]) ?? []);
  const name = (target: string) => {
    const node = byIri.get(target);
    if (!node) return null;
    return node.kind === 'external' ? (
      <span className="mono">{node.label}</span>
    ) : (
      <button type="button" className="link" onClick={() => onSelect(node.iri)}>
        {node.label}
      </button>
    );
  };

  return (
    <div className="term-graph-view">
      <Segmented
        label="Depth"
        options={[
          { value: '1', label: '1 hop' },
          { value: '2', label: '2 hops' },
        ]}
        value={depth}
        onChange={setDepth}
      />
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>Loading…</p>}
      {data && (
        <>
          <div className="term-graph" ref={canvas} aria-hidden="true" />
          {data.truncated && (
            <p className="muted">
              Showing the first {data.nodes.length} terms; pick one to see its own neighbours.
            </p>
          )}
          {data.edges.length === 0 ? (
            <p className="muted">No links to other terms.</p>
          ) : (
            <ul className="term-graph-links" aria-label="Links">
              {data.edges.map((e) => (
                <li key={`${e.source}|${e.kind}|${e.target}`}>
                  {name(e.source)} {PHRASE[e.kind]} {name(e.target)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
