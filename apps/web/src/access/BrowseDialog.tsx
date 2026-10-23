import { useEffect, useId, useState } from 'react';
import type { SinkBrowseNode } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { Icon } from '../ui/Icon.js';
import { groupedLabel, readShape, type BrowseShape } from './browse.js';

/** One level of the tree as loaded: its nodes, and the cursor of the next page (null: none). */
interface Level {
  nodes: SinkBrowseNode[];
  next: string | null;
}

/**
 * Picks a value for a sink's destination field from what the sink serves. A list is read whole
 * and shown with a filter above it, a click on an item picking it: flat (repositories), or
 * grouped under headings that can't be picked (object storages under their projects; the filter
 * matches the items, never a heading). Anything deeper (a space, a folder) is a tree shown one
 * level at a time: open a node to see what is inside it, More for the next page, Use to pick a
 * selectable node. The picked node's id becomes the field's value; its label (a grouped item's
 * with its group's in brackets) goes with it, for display.
 */
export function BrowseDialog({
  api,
  sinkId,
  instanceId,
  connectionId,
  field,
  label,
  onPick,
  onClose,
}: {
  api: Api;
  sinkId: string;
  instanceId: string | null;
  connectionId: string | null;
  field: string;
  label: string;
  onPick: (id: string, label: string) => void;
  onClose: () => void;
}) {
  const filterId = useId();
  const [levels, setLevels] = useState<Map<string | null, Level>>(new Map());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [needsConnection, setNeedsConnection] = useState(false);
  /** The tree's shape once read (a list is read whole). */
  const [shape, setShape] = useState<BrowseShape | null>(null);
  const [filter, setFilter] = useState('');

  const page = (parentId: string | null, cursor: string | null) =>
    api.browseSink({ sinkId, instanceId, connectionId, field, parentId, cursor });

  const fail = (err: unknown) => {
    const message = (err as Error).message;
    setNeedsConnection(/has no connection for/.test(message));
    setError(message);
  };

  const load = async (parentId: string | null, cursor: string | null) => {
    try {
      const r = await page(parentId, cursor);
      setLevels((all) => {
        const next = new Map(all);
        const before = cursor ? (all.get(parentId)?.nodes ?? []) : [];
        next.set(parentId, { nodes: [...before, ...r.nodes], next: r.nextCursor });
        return next;
      });
    } catch (err) {
      fail(err);
    }
  };

  useEffect(() => {
    // One first load per dialog: its props don't change while it is open.
    let live = true;
    readShape(page).then(
      (read) => {
        if (!live) return;
        if (read.kind === 'tree')
          setLevels(new Map([[null, { nodes: read.nodes, next: read.next }]]));
        setShape(read);
      },
      (err: unknown) => live && fail(err),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (n: SinkBrowseNode, as = n.label) => {
    onPick(n.id, as);
    onClose();
  };

  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else {
      next.add(id);
      if (!levels.has(id)) void load(id, null);
    }
    setOpen(next);
  };

  const tree = (parentId: string | null) => {
    const level = levels.get(parentId);
    if (!level) return <p className="muted">Loading…</p>;
    if (level.nodes.length === 0) return <p className="muted">Nothing here.</p>;
    return (
      <ul className="browse-level">
        {level.nodes.map((n) => (
          <li key={n.id}>
            {n.hasChildren ? (
              <button
                type="button"
                className="icon-button"
                aria-expanded={open.has(n.id)}
                aria-label={`Open ${n.label}`}
                onClick={() => toggle(n.id)}
              >
                <Icon name="chevronDown" />
              </button>
            ) : (
              <span className="browse-leaf" />
            )}
            <span>{n.label}</span>
            {n.selectable && (
              <button type="button" onClick={() => pick(n)}>
                Use {n.label}
              </button>
            )}
            {open.has(n.id) && tree(n.id)}
          </li>
        ))}
        {level.next && (
          <li>
            <button type="button" onClick={() => void load(parentId, level.next)}>
              More
            </button>
          </li>
        )}
      </ul>
    );
  };

  const q = filter.trim().toLowerCase();
  const matches = (nodes: SinkBrowseNode[]) =>
    nodes.filter((n) => n.selectable && n.label.toLowerCase().includes(q));
  const items = (nodes: SinkBrowseNode[], label: (n: SinkBrowseNode) => string) => (
    <ul className="browse-list">
      {nodes.map((n) => (
        <li key={n.id}>
          <button type="button" onClick={() => pick(n, label(n))}>
            {n.label}
          </button>
        </li>
      ))}
    </ul>
  );

  const list = (read: Exclude<BrowseShape, { kind: 'tree' }>) => {
    const total =
      read.kind === 'flat'
        ? read.nodes.length
        : read.groups.reduce((n, g) => n + g.nodes.length, 0);
    const groups =
      read.kind === 'grouped'
        ? read.groups
            .map((g) => ({ group: g.group, nodes: matches(g.nodes) }))
            .filter((g) => g.nodes.length > 0)
        : [];
    const flatShown = read.kind === 'flat' ? matches(read.nodes) : [];
    const none = read.kind === 'flat' ? flatShown.length === 0 : groups.length === 0;
    return (
      <>
        <span className="filter-search browse-filter">
          <Icon name="search" />
          <input
            id={filterId}
            type="search"
            aria-label={`Filter ${label.toLowerCase()}`}
            placeholder="Filter by name"
            value={filter}
            autoFocus
            onChange={(e) => setFilter(e.target.value)}
          />
        </span>
        {total === 0 ? (
          <p className="muted">Nothing here.</p>
        ) : none ? (
          <p className="muted">Nothing matches “{filter.trim()}”.</p>
        ) : read.kind === 'flat' ? (
          items(flatShown, (n) => n.label)
        ) : (
          <div className="browse-groups">
            {groups.map(({ group, nodes }) => (
              <section key={group.id} role="group" aria-label={group.label}>
                <h3>{group.label}</h3>
                {items(nodes, (n) => groupedLabel(group, n))}
              </section>
            ))}
          </div>
        )}
      </>
    );
  };

  return (
    <Dialog
      title={`Choose ${label.toLowerCase()}`}
      icon={<Icon name="list" size={32} />}
      className="browse-dialog"
      onClose={onClose}
    >
      {error ? (
        <div role="alert">
          <p>{error}</p>
          {needsConnection && (
            <button type="button" onClick={() => void api.openConnections()}>
              <Icon name="key" />
              Manage connections
            </button>
          )}
        </div>
      ) : shape && shape.kind !== 'tree' ? (
        list(shape)
      ) : shape ? (
        tree(null)
      ) : (
        <p className="muted">Loading…</p>
      )}
    </Dialog>
  );
}
