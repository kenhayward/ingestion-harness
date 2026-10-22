import { useEffect, useState } from 'react';
import type { SinkBrowseNode } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { Icon } from '../ui/Icon.js';

/** One level of the tree as loaded: its nodes, and the cursor of the next page (null: none). */
interface Level {
  nodes: SinkBrowseNode[];
  next: string | null;
}

/**
 * Picks a value for a sink's destination field from the tree the sink serves (a space, a
 * folder), one level at a time: open a node to see what is inside it, More for the next page.
 * Only a node the sink marks selectable can be picked; its id becomes the field's value.
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
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [levels, setLevels] = useState<Map<string | null, Level>>(new Map());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [needsConnection, setNeedsConnection] = useState(false);

  const load = async (parentId: string | null, cursor: string | null) => {
    try {
      const r = await api.browseSink({ sinkId, instanceId, connectionId, field, parentId, cursor });
      setLevels((all) => {
        const next = new Map(all);
        const before = cursor ? (all.get(parentId)?.nodes ?? []) : [];
        next.set(parentId, { nodes: [...before, ...r.nodes], next: r.nextCursor });
        return next;
      });
    } catch (err) {
      const message = (err as Error).message;
      setNeedsConnection(/has no connection for/.test(message));
      setError(message);
    }
  };

  useEffect(() => {
    void load(null, null);
    // One first load per dialog: its props don't change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else {
      next.add(id);
      if (!levels.has(id)) void load(id, null);
    }
    setOpen(next);
  };

  const list = (parentId: string | null) => {
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
              <button
                type="button"
                onClick={() => {
                  onPick(n.id);
                  onClose();
                }}
              >
                Use {n.label}
              </button>
            )}
            {open.has(n.id) && list(n.id)}
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

  return (
    <Dialog
      title={`Choose ${label.toLowerCase()}`}
      icon={<Icon name="list" size={32} />}
      className="browse-dialog"
      onClose={onClose}
      actions={
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      }
    >
      {error ? (
        <div role="alert">
          <p>
            {needsConnection
              ? `Add your connection for ${instanceId ?? sinkId} first: ${error}`
              : error}
          </p>
          {needsConnection && (
            <button type="button" onClick={() => void api.openConnections()}>
              <Icon name="key" />
              Manage connections
            </button>
          )}
        </div>
      ) : (
        list(null)
      )}
    </Dialog>
  );
}
