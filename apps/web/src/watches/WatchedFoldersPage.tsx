import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WatchSource, WatchView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { HelpButton } from '../ui/Help.js';
import { Icon } from '../ui/Icon.js';
import { moveFocus, usePopover } from '../ui/usePopover.js';
import { RemoveWatchDialog } from './RemoveWatchDialog.js';
import { StopWatchDialog } from './StopWatchDialog.js';
import { WatchDetail } from './WatchDetail.js';
import { WatchDialog } from './WatchDialog.js';
import { HEALTH, START_HINT, figuresText, pickupText, queueText, runAsName } from './derive.js';

type Dialog =
  { kind: 'new' } | { kind: 'reconfigure' | 'stop' | 'remove'; watch: WatchView } | null;

/**
 * Watched folders (admins; plan 3): a ledger of the folders CT Studio watches, each with its
 * health, queue and throughput, and the actions that start, stop, reconfigure and remove them.
 * A row opens its settings and recent events beside the ledger.
 */
export function WatchedFoldersPage({
  api,
  pollMs = 5000,
  now,
}: {
  api: Api;
  pollMs?: number;
  /** The time the page reads relative times against (tests); the clock otherwise. */
  now?: number;
}) {
  const [watches, setWatches] = useState<WatchView[] | null>(null);
  const [sources, setSources] = useState<WatchSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const load = useCallback(
    () =>
      api.listWatches().then(
        (list) => {
          setWatches([...list].sort((a, b) => a.name.localeCompare(b.name)));
          setError(null);
        },
        (err: Error) => setError(err.message),
      ),
    [api],
  );
  useEffect(() => {
    void load();
    // The targets' labels, and the New watch form's targets.
    api.listWatchSources().then(
      (list) => {
        setSources(list);
        setSourcesError(null);
      },
      (err: Error) => setSourcesError(err.message),
    );
  }, [api, load]);
  useEffect(() => {
    if (!pollMs) return;
    const timer = setInterval(() => {
      void load();
      setClock(Date.now());
    }, pollMs);
    return () => clearInterval(timer);
  }, [load, pollMs]);

  const at = now ?? clock;
  const targetLabel = (id: string) => sources.find((s) => s.targetId === id)?.label ?? id;
  const selected = watches?.find((w) => w.id === selectedId) ?? null;
  const replace = (w: WatchView) =>
    setWatches((list) => list?.map((x) => (x.id === w.id ? w : x)) ?? list);

  async function start(w: WatchView) {
    setActionError(null);
    try {
      replace(await api.startWatch(w.id));
    } catch (err) {
      setActionError(`${w.name} could not be started: ${(err as Error).message}`);
    }
  }

  return (
    <div className="watches-page conversion-page">
      <div className="page-header conversion-header">
        <div>
          <h1>Watched folders</h1>
          <p className="muted">
            Folders CT Studio looks in for Word or PDF files, converting each one it finds.
          </p>
        </div>
        <div className="page-header-actions">
          <button type="button" className="primary" onClick={() => setDialog({ kind: 'new' })}>
            <Icon name="plus" size={14} /> New watch
          </button>
          <HelpButton topic="watchedFolders" />
        </div>
      </div>

      {error && <p role="alert">The watches could not be read: {error}</p>}
      {sourcesError && <p role="alert">The targets could not be read: {sourcesError}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      {watches?.length === 0 && (
        <section className="card">
          <p className="muted">
            No folder is watched yet. <strong>New watch</strong> points CT Studio at one.
          </p>
        </section>
      )}
      {watches && watches.length > 0 && (
        <div className={selected ? 'watches-layout with-detail' : 'watches-layout'}>
          <section className="card watches-ledger">
            <table className="watch-list" aria-label="Watched folders">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Folder</th>
                  <th scope="col">Target</th>
                  <th scope="col">Runs as</th>
                  <th scope="col">Health</th>
                  <th scope="col">Queue</th>
                  <th scope="col">Last 24 h</th>
                  <th scope="col">Total</th>
                  <th scope="col">Last pickup</th>
                  <th scope="col">
                    <span className="visually-hidden">Batch</span>
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {watches.map((w) => (
                  <tr key={w.id} className={w.id === selectedId ? 'selected' : undefined}>
                    <td>
                      <button
                        type="button"
                        className="doc-button"
                        aria-pressed={w.id === selectedId}
                        onClick={() => setSelectedId(w.id === selectedId ? null : w.id)}
                      >
                        {w.name}
                      </button>
                    </td>
                    <td className="mono">{w.sourcePath}</td>
                    <td>{targetLabel(w.targetId)}</td>
                    <td>{runAsName(w)}</td>
                    <td>
                      <span className={`pill tone-${HEALTH[w.health].tone}`}>
                        {HEALTH[w.health].label}
                      </span>
                      {w.health === 'problem' && w.problem && (
                        <small className="watch-problem">{w.problem}</small>
                      )}
                    </td>
                    <td>{queueText(w)}</td>
                    <td>{figuresText(w.throughput.day)}</td>
                    <td>{figuresText(w.throughput.total)}</td>
                    <td>{pickupText(w.lastPickupAt, at)}</td>
                    <td>
                      {w.batchId && (
                        <a href={`#/conversion/${encodeURIComponent(w.batchId)}`}>Batch</a>
                      )}
                    </td>
                    <td className="act-cell">
                      <RowMenu
                        watch={w}
                        onReconfigure={() => setDialog({ kind: 'reconfigure', watch: w })}
                        onStop={() => setDialog({ kind: 'stop', watch: w })}
                        onStart={() => void start(w)}
                        onRemove={() => setDialog({ kind: 'remove', watch: w })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {selected && (
            <WatchDetail
              key={selected.id}
              api={api}
              watch={selected}
              target={targetLabel(selected.targetId)}
              now={at}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>
      )}

      {dialog?.kind === 'new' && (
        <WatchDialog
          api={api}
          sources={sources}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {dialog?.kind === 'reconfigure' && (
        <WatchDialog
          api={api}
          sources={sources}
          watch={dialog.watch}
          onClose={() => setDialog(null)}
          onSaved={(w) => {
            replace(w);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'stop' && (
        <StopWatchDialog
          api={api}
          watch={dialog.watch}
          onClose={() => setDialog(null)}
          onStopped={(w) => {
            replace(w);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'remove' && (
        <RemoveWatchDialog
          api={api}
          watch={dialog.watch}
          onClose={() => setDialog(null)}
          onRemoved={() => {
            setWatches((list) => list?.filter((x) => x.id !== dialog.watch.id) ?? null);
            if (selectedId === dialog.watch.id) setSelectedId(null);
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

/** A row's actions menu: reconfigure; stop (running), start and remove (stopped). */
function RowMenu({
  watch,
  onReconfigure,
  onStop,
  onStart,
  onRemove,
}: {
  watch: WatchView;
  onReconfigure: () => void;
  onStop: () => void;
  onStart: () => void;
  onRemove: () => void;
}) {
  const p = usePopover();
  const menu = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (p.open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [p.open]);
  useLayoutEffect(() => {
    if (!p.open || !menu.current) {
      setUp(false);
      return;
    }
    // Open upward when the menu would run past the bottom of the window.
    setUp(menu.current.getBoundingClientRect().bottom > window.innerHeight);
  }, [p.open]);
  const name = `Actions for ${watch.name}`;
  const run = (f: () => void) => () => {
    p.close();
    f();
  };
  return (
    <div className="popover-anchor" ref={p.box} onKeyDown={p.onKeyDown}>
      <button
        type="button"
        ref={p.trigger}
        className="icon"
        aria-label={name}
        title="Actions"
        aria-haspopup="menu"
        aria-expanded={p.open}
        onClick={() => p.setOpen(!p.open)}
      >
        <Icon name="more" size={18} strokeWidth={3} />
      </button>
      {p.open && (
        <div
          ref={menu}
          role="menu"
          aria-label={name}
          className={`menu-popover row-menu${up ? ' opens-up' : ''}`}
          onKeyDown={(e) => moveFocus(e, menu.current, '[role="menuitem"]')}
        >
          <button type="button" role="menuitem" onClick={run(onReconfigure)}>
            Reconfigure…
          </button>
          {watch.state === 'stopped' ? (
            <>
              <button type="button" role="menuitem" title={START_HINT} onClick={run(onStart)}>
                Start
              </button>
              <button type="button" role="menuitem" onClick={run(onRemove)}>
                Remove…
              </button>
            </>
          ) : (
            <button type="button" role="menuitem" onClick={run(onStop)}>
              Stop…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
