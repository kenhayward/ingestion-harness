import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { TermGroup } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { GROUP_LABEL, visibleRows, type LoadedChildren, type TreeRow } from './derive.js';

/** Children loaded per node: past this, the tree says how many more and search finds them. */
export const TREE_LIMIT = 500;

type TermRow = Extract<TreeRow, { kind: 'term' }>;

/** One group's hierarchy, loaded a level at a time as nodes open (ARIA tree, keyboard). */
export function TermTree({
  api,
  ontologyId,
  version,
  group,
  selected,
  onSelect,
}: {
  api: Api;
  ontologyId: string;
  version: number;
  group: TermGroup;
  selected: string | null;
  onSelect: (iri: string) => void;
}) {
  const [kids, setKids] = useState<Map<string, LoadedChildren>>(new Map());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const items = useRef<(HTMLLIElement | null)[]>([]);

  const fetchChildren = useCallback(
    async (parent: string) => {
      const page = await api.listOntologyTerms(
        ontologyId,
        version,
        parent ? { group, parent, limit: TREE_LIMIT } : { group, root: true, limit: TREE_LIMIT },
      );
      setKids((m) => new Map(m).set(parent, { items: page.items, total: page.total }));
    },
    [api, ontologyId, version, group],
  );

  useEffect(() => {
    setKids(new Map());
    setOpen(new Set());
    setFocus(0);
    setError(null);
    fetchChildren('').catch((err: Error) => setError(err.message));
  }, [fetchChildren]);

  const rows = visibleRows(kids, open);
  const expandable = (r: TreeRow): r is TermRow =>
    r.kind === 'term' && r.term.childCount > 0 && !r.cycle;

  const toggle = (r: TermRow) => {
    const next = new Set(open);
    if (next.has(r.path)) next.delete(r.path);
    else {
      next.add(r.path);
      if (!kids.has(r.term.iri)) {
        fetchChildren(r.term.iri).catch((err: Error) => setError(err.message));
      }
    }
    setOpen(next);
  };

  const move = (i: number) => {
    const target = Math.max(0, Math.min(rows.length - 1, i));
    setFocus(target);
    items.current[target]?.focus();
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLUListElement>) => {
    const row = rows[focus];
    if (!row) return;
    if (ev.key === 'ArrowDown') move(focus + 1);
    else if (ev.key === 'ArrowUp') move(focus - 1);
    else if (ev.key === 'ArrowRight' && expandable(row) && !open.has(row.path)) toggle(row);
    else if (ev.key === 'ArrowLeft' && row.kind === 'term') {
      if (open.has(row.path)) toggle(row);
      else {
        const parentPath = row.path.slice(0, row.path.lastIndexOf('/'));
        const parent = rows.findIndex((r) => r.path === parentPath);
        if (parent >= 0) move(parent);
      }
    } else if ((ev.key === 'Enter' || ev.key === ' ') && row.kind === 'term') {
      onSelect(row.term.iri);
    } else return;
    ev.preventDefault();
  };

  if (error) return <p role="alert">{error}</p>;
  if (!kids.has('')) return <p>Loading…</p>;
  if (rows.length === 0) {
    return <p className="muted">No {GROUP_LABEL[group].toLowerCase()} in this version.</p>;
  }
  return (
    <ul
      role="tree"
      aria-label={`${GROUP_LABEL[group]} hierarchy`}
      className="term-tree"
      onKeyDown={onKeyDown}
    >
      {rows.map((r, i) =>
        r.kind === 'more' ? (
          <li
            key={r.path}
            className="tree-more muted"
            style={{ paddingLeft: `${(r.level - 1) * 16 + 24}px` }}
          >
            and {r.hidden} more: search to find them
          </li>
        ) : (
          <li
            key={r.path}
            ref={(el) => {
              items.current[i] = el;
            }}
            role="treeitem"
            aria-level={r.level}
            aria-expanded={expandable(r) ? open.has(r.path) : undefined}
            aria-selected={selected === r.term.iri}
            tabIndex={i === focus ? 0 : -1}
            className={selected === r.term.iri ? 'tree-row selected' : 'tree-row'}
            style={{ paddingLeft: `${(r.level - 1) * 16}px` }}
            onClick={() => {
              setFocus(i);
              onSelect(r.term.iri);
            }}
          >
            {expandable(r) ? (
              <button
                type="button"
                className="icon tree-toggle"
                tabIndex={-1}
                aria-label={`${open.has(r.path) ? 'Collapse' : 'Expand'} ${r.term.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(r);
                }}
              >
                <Icon name={open.has(r.path) ? 'chevronDown' : 'chevronRight'} size={14} />
              </button>
            ) : (
              <span className="tree-leaf" aria-hidden="true" />
            )}
            <span className="term-label">{r.term.label}</span>
            {r.cycle && <span className="muted"> (cycle)</span>}
            {r.term.deprecated && <span className="tag tone-neutral">deprecated</span>}
          </li>
        ),
      )}
    </ul>
  );
}
