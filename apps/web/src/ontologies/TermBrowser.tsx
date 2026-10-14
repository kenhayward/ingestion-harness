import { useEffect, useState } from 'react';
import type { OntologyStats, TermGroup, TermPage } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { Segmented } from '../ui/Segmented.js';
import { GROUP_LABEL, groupCount } from './derive.js';
import { TermDetailPanel } from './TermDetailPanel.js';
import { TermTree } from './TermTree.js';

const GROUPS: TermGroup[] = ['classes', 'properties', 'concepts', 'shapes'];
export const SEARCH_LIMIT = 100;

/** A ready version's terms: one tab per group, a tree (or search hits) and a detail pane. */
export function TermBrowser({
  api,
  ontologyId,
  version,
  stats,
  searchDelayMs,
}: {
  api: Api;
  ontologyId: string;
  version: number;
  stats: OntologyStats | null;
  searchDelayMs: number;
}) {
  const [group, setGroup] = useState<TermGroup>(
    () => GROUPS.find((g) => groupCount(stats, g) > 0) ?? 'classes',
  );
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="term-browser">
      <div className="term-browser-bar">
        <Segmented
          label="Term kinds"
          options={GROUPS.map((g) => ({
            value: g,
            label: `${GROUP_LABEL[g]} (${groupCount(stats, g)})`,
          }))}
          value={group}
          onChange={(g) => {
            setGroup(g);
            setSelected(null);
          }}
        />
        <label className="search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Search terms"
            placeholder="Search terms"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="term-panes">
        <div className="term-list">
          {query.trim() ? (
            <TermResults
              api={api}
              ontologyId={ontologyId}
              version={version}
              group={group}
              query={query.trim()}
              delayMs={searchDelayMs}
              selected={selected}
              onSelect={setSelected}
            />
          ) : (
            <TermTree
              api={api}
              ontologyId={ontologyId}
              version={version}
              group={group}
              selected={selected}
              onSelect={setSelected}
            />
          )}
        </div>
        <div className="term-detail-pane">
          {selected ? (
            <TermDetailPanel
              api={api}
              ontologyId={ontologyId}
              version={version}
              iri={selected}
              onSelect={setSelected}
            />
          ) : (
            <p className="muted">Pick a term to see its definition and neighbours.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function TermResults({
  api,
  ontologyId,
  version,
  group,
  query,
  delayMs,
  selected,
  onSelect,
}: {
  api: Api;
  ontologyId: string;
  version: number;
  group: TermGroup;
  query: string;
  delayMs: number;
  selected: string | null;
  onSelect: (iri: string) => void;
}) {
  const [page, setPage] = useState<TermPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // Debounced: one request once typing pauses; a stale response never lands.
    const timer = setTimeout(() => {
      api.listOntologyTerms(ontologyId, version, { group, q: query, limit: SEARCH_LIMIT }).then(
        (p) => {
          if (!live) return;
          setPage(p);
          setError(null);
        },
        (err: Error) => {
          if (live) setError(err.message);
        },
      );
    }, delayMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, ontologyId, version, group, query, delayMs]);
  if (error) return <p role="alert">{error}</p>;
  if (!page) return <p>Searching…</p>;
  if (page.items.length === 0) return <p className="muted">No matching terms.</p>;
  return (
    <>
      <ul className="term-results" aria-label="Search results">
        {page.items.map((t) => (
          <li key={`${t.kind}:${t.iri}`}>
            <button type="button" aria-pressed={selected === t.iri} onClick={() => onSelect(t.iri)}>
              {t.label}
              {t.deprecated && <span className="tag tone-neutral">deprecated</span>}
            </button>
          </li>
        ))}
      </ul>
      {page.total > page.items.length && (
        <p className="muted">
          Showing the first {page.items.length} of {page.total}.
        </p>
      )}
    </>
  );
}
