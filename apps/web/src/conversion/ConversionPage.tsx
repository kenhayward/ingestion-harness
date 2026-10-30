import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import {
  BATCH_NAME_MAX,
  ITEM_OUTCOMES,
  type BatchSummary,
  type ConversionTarget,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { StatusGlyph } from '../jobs/JobStatusIcon.js';
import { navigate } from '../router.js';
import { Avatar } from '../shell/Avatar.js';
import { Dialog } from '../ui/Dialog.js';
import { HelpButton } from '../ui/Help.js';
import { Icon } from '../ui/Icon.js';
import { moveFocus, usePopover } from '../ui/usePopover.js';
import { BatchView } from './BatchView.js';
import { NewBatch } from './NewBatch.js';
import { OUTCOME, UNFINISHED, batchState } from './outcomes.js';

/** Earlier batches a page holds. */
export const BATCHES_PER_PAGE = 10;

/**
 * The Conversion tab (decomposition phase 3): Word or PDF documents converted in batches and delivered
 * to a target that takes documents. Operators, designers and admins all use it (ruling R1).
 * `#/conversion` starts a new batch and lists the earlier ones; `#/conversion/<batchId>` shows
 * one, under its own header ([handoff](docs/design/conversion-redesign/CONVERSION-HANDOFF.md)).
 */
export function ConversionPage({ api, batchId }: { api: Api; batchId?: string }) {
  if (batchId)
    return (
      <div className="conversion-page conversion-batch-page">
        <BatchView key={batchId} api={api} batchId={batchId} />
      </div>
    );
  return (
    <div className="conversion-page">
      <div className="page-header conversion-header">
        <div>
          <h1>Conversion</h1>
          <p className="muted">
            Convert Word or PDF documents and deliver each as a document of its own.
          </p>
        </div>
        <div className="page-header-actions">
          <HelpButton topic="conversion" />
        </div>
      </div>
      <NewBatch api={api} />
      <EarlierBatches api={api} />
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Today, 11:00", else "Fri, Oct 23" (the full time on hover). */
export function batchDay(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
const fullWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A batch's outcomes as chips, in outcome order, the ones it has only. */
function OutcomeChips({ batch }: { batch: BatchSummary }) {
  const present = ITEM_OUTCOMES.filter((o) => (batch.counts[o] ?? 0) > 0);
  if (batch.state === 'open') return <span className="muted">never started</span>;
  if (batch.state === 'discarded') return <span className="muted">discarded</span>;
  return (
    <span className="outcome-chips">
      {present.map((o) => (
        <span key={o} className={`pill tone-${OUTCOME[o].tone}`}>
          {batch.counts[o]} {OUTCOME[o].label.toLowerCase()}
        </span>
      ))}
    </span>
  );
}

/** A batch's documents not finished yet (held ones too): it can't be deleted while it has any. */
export const unfinishedIn = (b: BatchSummary) =>
  [...UNFINISHED, 'awaiting_review' as const].reduce((n, o) => n + (b.counts[o] ?? 0), 0);

/**
 * The batches started before, newest first, a page at a time, each a link to its view, named
 * by its name or else by when it was made, with who started it, and a menu to rename it or,
 * once its documents have all finished, delete it.
 */
function EarlierBatches({ api }: { api: Api }) {
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);
  const [targets, setTargets] = useState<ConversionTarget[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [deleting, setDeleting] = useState<BatchSummary | null>(null);
  const [renaming, setRenaming] = useState<BatchSummary | null>(null);

  useEffect(() => {
    api.listConversionBatches().then(
      (list) => setBatches([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
      (err: Error) => setError(err.message),
    );
    api.listConversionTargets().then(setTargets, () => undefined); // labels only: ids will do
  }, [api]);

  if (!error && !batches?.length) return null;
  const all = batches ?? [];
  const pages = Math.max(1, Math.ceil(all.length / BATCHES_PER_PAGE));
  const at = Math.min(page, pages - 1);
  const shown = all.slice(at * BATCHES_PER_PAGE, (at + 1) * BATCHES_PER_PAGE);
  const from = at * BATCHES_PER_PAGE;

  return (
    <section className="card earlier-batches" aria-labelledby="earlier-batches">
      <div className="earlier-batches-bar">
        <h2 className="section-heading" id="earlier-batches">
          Earlier batches
        </h2>
        {all.length > 0 && (
          <nav className="jobs-pager" aria-label="Pages of batches">
            <span className="jobs-pager-range">
              {from + 1}–{from + shown.length} of {all.length}
            </span>
            <span className="jobs-pager-buttons">
              <button
                type="button"
                aria-label="Newer batches"
                disabled={at === 0}
                onClick={() => setPage(at - 1)}
              >
                ‹ Newer
              </button>
              <span className="jobs-pager-page" aria-live="polite">
                Page <strong>{at + 1}</strong> of {pages}
              </span>
              <button
                type="button"
                aria-label="Older batches"
                disabled={at >= pages - 1}
                onClick={() => setPage(at + 1)}
              >
                Older ›
              </button>
            </span>
          </nav>
        )}
      </div>
      {error && <p role="alert">The earlier batches could not be read: {error}</p>}
      {shown.length > 0 && (
        <table className="batch-list" aria-label="Earlier batches">
          <colgroup>
            <col className="status-col" />
            <col className="name-col" />
            <col className="target-col" />
            <col className="docs-col" />
            <col className="outcomes-col" />
            <col className="by-col" />
            <col className="act-col" />
            <col className="go-col" />
          </colgroup>
          <tbody>
            {shown.map((b) => {
              const target = targets.find((t) => t.id === b.targetId);
              const state = batchState(b);
              const href = `#/conversion/${encodeURIComponent(b.id)}`;
              return (
                <tr
                  key={b.id}
                  onClick={(e) => {
                    // The whole row opens the batch; its date is the link for the keyboard.
                    if (!(e.target as HTMLElement).closest('a, button')) navigate(href);
                  }}
                >
                  <td className="status-cell">
                    <StatusGlyph {...state} />
                  </td>
                  <td className="when-cell">
                    <a href={href} title={fullWhen(b.createdAt)}>
                      {b.name ?? batchDay(b.createdAt)}
                    </a>
                    {b.name && <span className="muted"> · {batchDay(b.createdAt)}</span>}
                  </td>
                  <td className="target-cell">
                    {target ? `${target.label} · ${target.sinkName}` : b.targetId}
                    {b.force && <span className="force-tag">Force-load</span>}
                    {b.autoApprove && <span className="force-tag">Auto Approve</span>}
                    {b.watch && <span className="force-tag">Watched: {b.watch.name}</span>}
                  </td>
                  <td className="docs-cell">{plural(b.itemCount, 'doc')}</td>
                  <td className="outcomes-cell">
                    <OutcomeChips batch={b} />
                  </td>
                  <td className="by-cell" title={startedBy(b)}>
                    {b.createdBy.name && (
                      <>
                        <Avatar name={b.createdBy.name} />
                        <span className="by-name">{b.createdBy.name}</span>
                      </>
                    )}
                  </td>
                  <td className="act-cell">
                    <BatchMenu
                      batch={b}
                      onRename={() => setRenaming(b)}
                      onDelete={() => setDeleting(b)}
                    />
                  </td>
                  <td className="go-cell" aria-hidden="true">
                    <Icon name="chevronRight" size={14} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {renaming && (
        <RenameBatchDialog
          api={api}
          batch={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={(name) => {
            setBatches(
              (list) => list?.map((x) => (x.id === renaming.id ? { ...x, name } : x)) ?? null,
            );
            setRenaming(null);
          }}
        />
      )}
      {deleting && (
        <DeleteBatchDialog
          api={api}
          batch={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setBatches((list) => list?.filter((x) => x.id !== deleting.id) ?? null);
            setDeleting(null);
          }}
        />
      )}
    </section>
  );
}

/** "Started by Ada" (or "Created by", never started), for a row's hover. */
const startedBy = (b: BatchSummary) =>
  b.createdBy.name
    ? `${b.state === 'started' ? 'Started' : 'Created'} by ${b.createdBy.name}`
    : undefined;

/** The batch named in a menu or a dialog: its name, else when it was made. */
const batchLabel = (b: BatchSummary) => b.name ?? `the batch of ${fullWhen(b.createdAt)}`;

/**
 * A row's `⋯` menu: Rename…, and Delete…, off (saying why) while the batch has documents not
 * finished. It opens upward when it would run past the bottom of the window.
 */
function BatchMenu({
  batch,
  onRename,
  onDelete,
}: {
  batch: BatchSummary;
  onRename: () => void;
  onDelete: () => void;
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
    setUp(menu.current.getBoundingClientRect().bottom > window.innerHeight);
  }, [p.open]);
  const unfinished = unfinishedIn(batch);
  const why = unfinished > 0 ? `${plural(unfinished, 'document')} not finished yet` : undefined;
  const name = `Actions for ${batchLabel(batch)}`;
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
          onKeyDown={(e) => moveFocus(e, menu.current, '[role="menuitem"]:not(:disabled)')}
        >
          <button type="button" role="menuitem" onClick={run(onRename)}>
            Rename…
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger-item"
            disabled={why !== undefined}
            title={why}
            onClick={run(onDelete)}
          >
            Delete…
          </button>
        </div>
      )}
    </div>
  );
}

/** Naming a batch: its name, trimmed; an empty one clears it, and the list shows when it was made. */
function RenameBatchDialog({
  api,
  batch,
  onClose,
  onRenamed,
}: {
  api: Api;
  batch: BatchSummary;
  onClose: () => void;
  onRenamed: (name: string | null) => void;
}) {
  const formId = useId();
  const [name, setName] = useState(batch.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const unchanged = trimmed === (batch.name ?? '');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (unchanged || busy) return;
    setBusy(true);
    setError(null);
    try {
      onRenamed((await api.renameConversionBatch(batch.id, trimmed || null)).name);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Rename batch"
      onClose={onClose}
      actions={
        <button type="submit" form={formId} className="primary" disabled={busy || unchanged}>
          Rename
        </button>
      }
    >
      <form
        id={formId}
        className="dialog-form"
        aria-label="Rename batch"
        onSubmit={(e) => void submit(e)}
      >
        <label>
          Name
          <input
            value={name}
            maxLength={BATCH_NAME_MAX}
            placeholder={batchDay(batch.createdAt)}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <p className="muted">
          The batch of {fullWhen(batch.createdAt)}. Leave the name empty to list it by when it was
          made.
        </p>
        {error && <p role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}

/** Deleting a batch, once confirmed: what goes, and what stays in the target. */
function DeleteBatchDialog({
  api,
  batch,
  onClose,
  onDeleted,
}: {
  api: Api;
  batch: BatchSummary;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteConversionBatch(batch.id);
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Delete this batch?"
      onClose={onClose}
      actions={
        <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
          Delete batch
        </button>
      }
    >
      <p>
        {batch.name ? `${batch.name}, the batch of ` : 'The batch of '}
        {fullWhen(batch.createdAt)}, {plural(batch.itemCount, 'document')}, leaves this list, with
        its uploaded files and reports.
        {batch.state === 'started' &&
          ' The documents it delivered stay in the target, and are still found there when loaded again.'}
      </p>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
