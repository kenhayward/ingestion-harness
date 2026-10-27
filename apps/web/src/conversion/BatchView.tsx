import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BatchDetail, ConversionTarget, Item } from '@ih/shared';
import { ApiError, type Api } from '../api/client.js';
import { StatusGlyph } from '../jobs/JobStatusIcon.js';
import { usePageSize } from '../jobs/usePageSize.js';
import { navigate } from '../router.js';
import { Avatar } from '../shell/Avatar.js';
import { FilterChips, type FilterChip } from '../ui/FilterChips.js';
import { HelpButton } from '../ui/Help.js';
import { Icon } from '../ui/Icon.js';
import { StatusPill } from '../ui/StatusPill.js';
import { moveFocus, usePopover } from '../ui/usePopover.js';
import {
  ItemActions,
  ItemDialog,
  canDetach,
  canForce,
  canRedeliver,
  canReload,
  canResolve,
  type ActionResult,
  type DialogKind,
} from './ItemActions.js';
import {
  OUTCOME,
  OUTCOME_ICON,
  OUTCOME_NOTE,
  RESOLUTION,
  isAwaitingReview,
  isDelivered,
  isDone,
  isFailed,
  isUnfinished,
  itemTiming,
  needsAttention,
  spokenDuration,
  spokenSize,
} from './outcomes.js';
import { ReportPanel } from './ReportPanel.js';
import { RetryDialog } from './RetryDialog.js';

/** How often the view reads the batch again while anything in it is unfinished. */
export const BATCH_POLL_MS = 3000;

/** Rows a page holds before the list is measured (and where it cannot be: tests). */
export const DOCUMENTS_PER_PAGE = 50;

type Filter = 'all' | 'attention' | 'failed' | 'done';
const FILTERS: Record<Filter, (item: Item) => boolean> = {
  all: () => true,
  attention: needsAttention,
  failed: isFailed,
  done: isDone,
};

/**
 * Re-run applies to a failed document of a started batch that was never run again: a document
 * is re-run once, and a failed re-run is re-run from its own batch (`Item.rerunIn`).
 */
const canRetry = (started: boolean, item: Item) =>
  started && item.outcome === 'failed' && item.rerunIn === null;
const fileTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
/** "QA/SOPs/" of "QA/SOPs/a.docx"; empty for a file at the top. */
const folderOf = (sourceKey: string) => sourceKey.slice(0, sourceKey.lastIndexOf('/') + 1);
/** How long a finished batch took: its start to its last document's finish. */
function batchTook(detail: BatchDetail): string | null {
  const { batch, items } = detail;
  if (!batch.startedAt || items.length === 0 || items.some(isUnfinished)) return null;
  const ends = items.map((i) => (i.finishedAt ? Date.parse(i.finishedAt) : NaN));
  if (ends.some(Number.isNaN)) return null;
  return spokenDuration((Math.max(...ends) - Date.parse(batch.startedAt)) / 1000);
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
/** A link the target gave is followed only when it is a web address. */
const webLink = (link: string | null) => (link && /^https?:\/\//i.test(link) ? link : null);

/**
 * The progress said to assistive technology: how many documents are done, how many await review
 * (not done: a batch with one isn't finished, §14.6), and how many else need a look.
 */
function progressOf(items: Item[]): string {
  const total = items.length;
  const awaiting = items.filter(isAwaitingReview).length;
  const left = items.filter(isUnfinished).length + awaiting;
  const attention = items.filter((i) => needsAttention(i) && !isAwaitingReview(i)).length;
  const parts = [
    left === 0
      ? `All ${plural(total, 'document')} done`
      : `${total - left} of ${plural(total, 'document')} done`,
  ];
  if (awaiting) parts.push(`${awaiting} awaiting review`);
  if (attention) parts.push(`${attention} ${attention === 1 ? 'needs' : 'need'} attention`);
  return parts.join('; ');
}

/**
 * One conversion batch (decomposition phase 3): a row per document with its outcome (§3), its
 * detail, its link in the target and its report, and the row actions that apply. It reads the
 * batch again every few seconds while any document is queued, decomposing or delivering (a
 * `decompose` job has no live events of its own here), and stops once none is; a first read that
 * fails is tried again on the same beat. Each time the number of unfinished documents changes, a
 * polite status says how far it has got. A started batch carries on without the page, so
 * `#/conversion/<batchId>` picks it up after a reload. Each row says how long its document took
 * (or has run so far, as of the latest read). A row action's dialog is kept here, so a
 * refresh that moves its row (out of the filter, say) leaves it open, saying what changed.
 */
export function BatchView({
  api,
  batchId,
  pollMs = BATCH_POLL_MS,
  rowsPerPage = DOCUMENTS_PER_PAGE,
}: {
  api: Api;
  batchId: string;
  pollMs?: number;
  /** Rows a page holds until the list is measured. */
  rowsPerPage?: number;
}) {
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; missing: boolean } | null>(null);
  /** Bumped to read the batch again (the timer, or after an action). */
  const [reads, setReads] = useState(0);
  /** Bumped when a read settles, so the next timer is set from what it found. */
  const [settled, setSettled] = useState(0);
  const latest = useRef(0);
  const [targets, setTargets] = useState<ConversionTarget[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [report, setReport] = useState<Item | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ itemId: string; kind: DialogKind } | null>(null);
  /** The progress announced: set only when the number of unfinished documents changes. */
  const [progress, setProgress] = useState('');
  /** The row picked; none picked: the first needing attention, else the first. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [retry, setRetry] = useState<{ title: string; items: Item[] } | null>(null);
  const { box: rowsBox, size: pageSize } = usePageSize<HTMLDivElement>(rowsPerPage);

  useEffect(() => {
    api.listConversionTargets().then(setTargets, () => undefined); // labels only: ids will do
  }, [api]);

  useEffect(() => {
    let live = true;
    const read = ++latest.current;
    api.getConversionBatch(batchId).then(
      (d) => {
        if (!live || read !== latest.current) return;
        setDetail(d);
        setLoadError(null);
        setSettled((n) => n + 1);
      },
      (err: Error) => {
        if (!live || read !== latest.current) return;
        const missing = err instanceof ApiError && err.status === 404;
        setLoadError({ message: err.message, missing });
        setSettled((n) => n + 1);
      },
    );
    return () => {
      live = false;
    };
  }, [api, batchId, reads]);

  const running =
    detail !== null &&
    detail.batch.state === 'started' &&
    detail.items.some(isUnfinished) &&
    !loadError?.missing;
  /** Read again on the same beat: while documents are under way, or after a failed first read. */
  const polling = running || (detail === null && loadError !== null && !loadError.missing);
  const started = detail?.batch.state === 'started';
  const unfinished = detail ? detail.items.filter(isUnfinished).length : -1;

  useEffect(() => {
    if (started && detail) setProgress(progressOf(detail.items));
    // Only a change in how many are unfinished is announced, not every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, unfinished]);

  useEffect(() => {
    if (!polling) return;
    const timer = setTimeout(() => setReads((n) => n + 1), pollMs);
    return () => clearTimeout(timer);
  }, [polling, settled, pollMs]);

  function acted(r: ActionResult) {
    setResult(r);
    if (r.item) {
      const changed = r.item;
      setDetail((d) =>
        d ? { ...d, items: d.items.map((i) => (i.id === changed.id ? changed : i)) } : d,
      );
    }
    if (!r.failed) setReads((n) => n + 1);
  }

  async function discard() {
    setDiscardError(null);
    try {
      await api.discardConversionBatch(batchId);
      navigate('#/conversion');
    } catch (err) {
      setDiscardError((err as Error).message);
    }
  }

  if (loadError?.missing) {
    return (
      <section className="card" aria-label="Batch">
        <p role="alert">No such batch: it may have been discarded.</p>
        <a href="#/conversion">New batch</a>
      </section>
    );
  }
  if (!detail) {
    return (
      <section className="card" aria-label="Batch">
        {loadError ? (
          <>
            <p role="alert">The batch could not be read: {loadError.message}</p>
            <button type="button" onClick={() => setReads((n) => n + 1)}>
              Try again
            </button>
          </>
        ) : (
          <p className="muted">Reading the batch…</p>
        )}
      </section>
    );
  }

  const { batch, items } = detail;
  const targetInfo = targets.find((t) => t.id === batch.targetId);
  const target = targetInfo?.label ?? batch.targetId;
  const needle = query.trim().toLowerCase();
  const shown = items
    .filter(FILTERS[filter])
    .filter((i) => !needle || i.sourceKey.toLowerCase().includes(needle));
  const pages = Math.max(1, Math.ceil(shown.length / pageSize));
  const at = Math.min(page, pages - 1);
  const onPage = shown.slice(at * pageSize, (at + 1) * pageSize);
  const selected =
    items.find((i) => i.id === selectedId) ?? items.find(needsAttention) ?? items[0] ?? null;
  /** The item of the open dialog, as last read (all items: the filter may hide its row). */
  const open = dialog ? items.find((i) => i.id === dialog.itemId) : undefined;
  const failed = items.filter(isFailed);
  const retryable = items.filter((i) => canRetry(started, i));
  const attention = items.filter(needsAttention);
  const chips: FilterChip<Filter>[] = [
    { value: 'all', label: 'All', count: items.length },
    { value: 'attention', label: 'Needs attention', count: attention.length, tone: 'warn' },
    { value: 'failed', label: 'Failed', count: failed.length },
    { value: 'done', label: 'Done', count: items.filter(isDone).length },
  ];
  const took = batchTook(detail);
  const startedAt = batch.startedAt ?? batch.createdAt;
  const retryAll = () =>
    setRetry({
      title: `Re-run ${plural(retryable.length, 'failed document')}`,
      items: retryable,
    });
  const retryOne = (item: Item) => setRetry({ title: `Re-run ${item.sourceKey}`, items: [item] });
  const pick = (f: Filter) => {
    setFilter(f);
    setPage(0);
  };

  return (
    <section className="batch-view" aria-labelledby="batch-heading">
      <a className="back-link" href="#/conversion">
        <span aria-hidden="true">‹ </span>Conversion
      </a>
      <div className="batch-head">
        <div className="batch-head-text">
          <h1 id="batch-heading">Batch · {when(startedAt)}</h1>
          <p className="batch-meta muted">
            {target}
            {targetInfo && <span className="sink-tag">{targetInfo.sinkName}</span>}
            {batch.createdBy.name && (
              <>
                {started ? ' · started by ' : ' · created by '}
                <Avatar name={batch.createdBy.name} />
                {batch.createdBy.name}
              </>
            )}
            {took && ` · took ${took}`}
            {batch.force && <span className="force-tag">Force-load</span>}
          </p>
        </div>
        <div className="batch-head-actions">
          <a className="button" href="#/conversion">
            New batch
          </a>
          {retryable.length > 0 && (
            <button type="button" className="primary" onClick={retryAll}>
              <Icon name="refresh" size={14} /> Re-run {retryable.length} failed
            </button>
          )}
          <HelpButton topic="conversion" />
        </div>
      </div>

      {batch.state === 'open' && (
        <div className="callout tone-warn">
          <p>
            This batch was never started: its files were uploaded, but nothing converts them. Start
            a new batch with the files, and discard this one.
          </p>
          <button type="button" onClick={() => void discard()}>
            Discard the batch
          </button>
          {discardError && <p role="alert">{discardError}</p>}
        </div>
      )}
      {batch.state === 'discarded' && <p className="muted">This batch was discarded.</p>}

      <Totals items={items} />

      {running && (
        <p className="live">
          <span className="live-dot" aria-hidden="true" />
          Documents are under way: this list refreshes every few seconds.
        </p>
      )}
      <p
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label="Progress"
      >
        {progress}
      </p>
      {loadError && <p role="alert">The batch could not be refreshed: {loadError.message}</p>}

      {result && (
        <p role={result.failed ? 'alert' : 'status'} aria-label="Action">
          {result.message}{' '}
          {result.batchId && (
            <a href={`#/conversion/${encodeURIComponent(result.batchId)}`}>Open the new batch</a>
          )}
        </p>
      )}

      <div className="batch-work">
        <div className="batch-list-box">
          <div className="batch-list-bar">
            <FilterChips label="Show" chips={chips} value={filter} onChange={pick} />
            <input
              type="search"
              className="batch-find"
              aria-label="Find a document"
              placeholder="Find a document"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
            <nav className="jobs-pager" aria-label="Pages of documents">
              <span className="jobs-pager-buttons">
                <button
                  type="button"
                  aria-label="Previous page"
                  disabled={at === 0}
                  onClick={() => setPage(at - 1)}
                >
                  ‹ Prev
                </button>
                <span className="jobs-pager-page" aria-live="polite">
                  Page <strong>{at + 1}</strong> of {pages}
                </span>
                <button
                  type="button"
                  aria-label="Next page"
                  disabled={at >= pages - 1}
                  onClick={() => setPage(at + 1)}
                >
                  Next ›
                </button>
              </span>
            </nav>
          </div>
          <div className="batch-list-rows" ref={rowsBox}>
            {shown.length === 0 ? (
              <p className="muted batch-list-empty">
                {needle
                  ? 'No document matches.'
                  : filter === 'attention'
                    ? 'Nothing needs attention.'
                    : filter === 'failed'
                      ? 'Nothing failed.'
                      : 'No document here yet.'}
              </p>
            ) : (
              <table className="batch-table" aria-label="Documents">
                <colgroup>
                  <col className="status-col" />
                  <col className="doc-col" />
                  <col className="outcome-col" />
                  <col className="detail-col" />
                  <col className="took-col" />
                  <col className="open-col" />
                  <col className="actions-col" />
                </colgroup>
                <thead className="visually-hidden">
                  <tr>
                    <th scope="col">State</th>
                    <th scope="col">Document</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Detail</th>
                    <th scope="col">Took</th>
                    <th scope="col">In the target</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {onPage.map((item) => (
                    <DocumentRow
                      key={item.id}
                      api={api}
                      item={item}
                      selected={item.id === selected?.id}
                      canRerun={canRetry(started, item)}
                      onSelect={() => setSelectedId(item.id)}
                      onRerun={() => retryOne(item)}
                      onReport={() => setReport(item)}
                      onOpen={(kind) => setDialog({ itemId: item.id, kind })}
                      onResult={acted}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {selected && (
          <DocumentPanel
            key={selected.id}
            api={api}
            item={selected}
            canRerun={canRetry(started, selected)}
            onRerun={() => retryOne(selected)}
            onReport={() => setReport(selected)}
            onOpen={(kind) => setDialog({ itemId: selected.id, kind })}
            onResult={acted}
          />
        )}
      </div>

      {report && <ReportPanel api={api} item={report} onClose={() => setReport(null)} />}
      {open && dialog && (
        <ItemDialog
          api={api}
          item={open}
          kind={dialog.kind}
          onClose={() => setDialog(null)}
          onSwitch={(kind) => setDialog({ itemId: open.id, kind })}
          onResult={acted}
        />
      )}
      {retry && (
        <RetryDialog
          api={api}
          batch={batch}
          items={retry.items}
          target={targetInfo}
          title={retry.title}
          onClose={() => setRetry(null)}
        />
      )}
    </section>
  );
}

/** The batch's totals as tiles, and a bar of its outcomes by tone. */
function Totals({ items }: { items: Item[] }) {
  const count = (f: (i: Item) => boolean) => items.filter(f).length;
  const tiles = [
    { n: items.length, label: 'documents', tone: '' },
    { n: count(isDelivered), label: 'created or updated', tone: 'ok' },
    { n: count((i) => i.outcome === 'already_loaded'), label: 'already loaded', tone: '' },
    {
      n: count((i) => needsAttention(i) && !isFailed(i)),
      label: 'need attention',
      tone: 'warn',
    },
    { n: count((i) => needsAttention(i) && isFailed(i)), label: 'failed', tone: 'danger' },
  ];
  const tones = ['ok', 'neutral', 'info', 'warn', 'alert', 'danger'] as const;
  const toneOf = (i: Item) =>
    i.resolution ? 'neutral' : isUnfinished(i) ? 'info' : OUTCOME[i.outcome].tone;
  const segments = tones
    .map((tone) => ({ tone, n: count((i) => toneOf(i) === tone) }))
    .filter((s) => s.n > 0);
  return (
    <div className="batch-totals card">
      <div role="group" aria-label="Totals" className="batch-tiles">
        {tiles.map((t) => (
          <div key={t.label} className="batch-tile">
            <strong className={t.tone && t.n > 0 ? `tone-text-${t.tone}` : undefined}>{t.n}</strong>
            <span>{t.label}</span>
          </div>
        ))}
      </div>
      <div className="batch-bar-wrap">
        <div className="batch-bar" aria-hidden="true">
          {segments.map((s) => (
            <span
              key={s.tone}
              className={`batch-bar-part tone-bg-${s.tone}`}
              style={{ flexGrow: s.n }}
            />
          ))}
        </div>
        <p className="muted batch-bar-text">{items.length ? progressOf(items) : 'No documents'}</p>
      </div>
    </div>
  );
}

interface RowProps {
  api: Api;
  item: Item;
  canRerun: boolean;
  onRerun: () => void;
  onReport: () => void;
  onOpen: (kind: DialogKind) => void;
  onResult: (r: ActionResult) => void;
}

/** "12 flags" (§4.9): how many places the decomposition wants a look; null for an old item. */
const flagsOf = (item: Item) =>
  item.flagCount === null
    ? null
    : item.flagCount === 0
      ? 'No flags'
      : plural(item.flagCount, 'flag');

/** The link to a held item's review page. */
function ReviewLink({ item }: { item: Item }) {
  if (item.outcome !== 'awaiting_review') return null;
  return (
    <a
      className="review-link"
      href={`#/conversion/items/${encodeURIComponent(item.id)}/review`}
      aria-label={`Review ${item.sourceKey}`}
    >
      Review
    </a>
  );
}

/** One document on one line: a click picks it for the panel; its `⋯` menu acts on it. */
function DocumentRow({
  item,
  selected,
  onSelect,
  ...actions
}: RowProps & { selected: boolean; onSelect: () => void }) {
  const link = webLink(item.link);
  const timing = itemTiming(item, Date.now());
  return (
    <tr
      aria-current={selected ? 'true' : undefined}
      className={selected ? 'selected' : undefined}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('a, .popover-anchor')) onSelect();
      }}
    >
      <td className="status-cell">
        <StatusGlyph
          icon={OUTCOME_ICON[item.outcome]}
          tone={OUTCOME[item.outcome].tone}
          label={OUTCOME[item.outcome].label}
        />
      </td>
      <td className="doc-cell">
        <button type="button" className="doc-button mono" title={item.sourceKey} onClick={onSelect}>
          {item.sourceKey}
        </button>
      </td>
      <td className="outcome-cell">
        <StatusPill {...OUTCOME[item.outcome]} />
      </td>
      <td className="detail-cell">
        {item.resolution && (
          <span className="conversion-resolution">{RESOLUTION[item.resolution]} </span>
        )}
        {item.detail ?? (item.outcome === 'rejected' ? item.reviewNote : null)}
        {OUTCOME_NOTE[item.outcome] && <span className="muted"> {OUTCOME_NOTE[item.outcome]}</span>}
        {flagsOf(item) && <span className="muted"> {flagsOf(item)}</span>}
        {item.outcome === 'awaiting_review' && (
          <>
            {' '}
            <ReviewLink item={item} />
          </>
        )}
        {item.rerunIn && (
          <>
            {' '}
            <RerunLink item={item} />
          </>
        )}
      </td>
      <td className="took-cell" title={timing ?? undefined}>
        {timing?.replace(/^took /, '')}
      </td>
      <td className="open-cell">
        {link ? (
          <a href={link} target="_blank" rel="noopener noreferrer" aria-label="Open in the target">
            Open <Icon name="open" size={12} />
          </a>
        ) : (
          <span className="muted" aria-hidden="true">
            —
          </span>
        )}
      </td>
      <td className="actions-cell">
        <RowMenu {...actions} item={item} />
      </td>
    </tr>
  );
}

/** Where a document was run again: the batch it was re-run in, by when that started. */
function RerunLink({ item }: { item: Item }) {
  if (!item.rerunIn) return null;
  return (
    <a className="rerun-link" href={`#/conversion/${encodeURIComponent(item.rerunIn)}`}>
      Re-run in batch {item.rerunAt ? when(item.rerunAt) : item.rerunIn}
    </a>
  );
}

/**
 * A row's `⋯` menu: re-run, its report, its original, then the actions that apply to it. Choosing
 * an item closes it and puts focus back on its button, so a dialog it opens gives focus back
 * there. It opens upward when the list's box has no room for it below its row.
 */
function RowMenu({ api, item, canRerun, onRerun, onReport, onOpen, onResult }: RowProps) {
  const p = usePopover();
  const menu = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    if (!p.open || !menu.current) {
      setUp(false);
      return;
    }
    // The rows' box clips what overflows it (it never scrolls): open upward past its bottom.
    const bottom = menu.current.closest('.batch-list-rows')?.getBoundingClientRect().bottom;
    setUp(bottom !== undefined && menu.current.getBoundingClientRect().bottom > bottom);
  }, [p.open]);
  useEffect(() => {
    if (p.open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [p.open]);
  const name = `Actions for ${item.sourceKey}`;
  const more =
    canForce(item) || canRedeliver(item) || canReload(item) || canResolve(item) || canDetach(item);
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
          className={`menu-popover row-menu batch-row-menu${up ? ' opens-up' : ''}`}
          onKeyDown={(e) => moveFocus(e, menu.current, '[role="menuitem"]')}
          onClick={(e) => {
            // An action of the item's own (force-load, redeliver, …) closes the menu too.
            if ((e.target as HTMLElement).closest('[role="menuitem"]')) p.close();
          }}
        >
          {canRerun && (
            <button type="button" role="menuitem" onClick={run(onRerun)}>
              Re-run
            </button>
          )}
          <button type="button" role="menuitem" onClick={run(onReport)}>
            View report
          </button>
          <a role="menuitem" href={api.conversionSourceUrl(item.id)} download={item.filename}>
            Download original
          </a>
          {more && <div role="separator" className="menu-separator" />}
          <ItemActions api={api} item={item} onOpen={onOpen} onResult={onResult} menu />
        </div>
      )}
    </div>
  );
}

/** The picked document beside the list: why it stands where it does, its times, its actions. */
function DocumentPanel({ api, item, canRerun, onRerun, onReport, onOpen, onResult }: RowProps) {
  const link = webLink(item.link);
  const timing = itemTiming(item, Date.now());
  const folder = folderOf(item.sourceKey);
  const rejected = item.outcome === 'rejected';
  const why = rejected
    ? 'Why it was rejected'
    : isFailed(item)
      ? 'Why it failed'
      : needsAttention(item)
        ? 'Why it needs attention'
        : null;
  const whyText = rejected ? item.reviewNote : item.detail;
  return (
    <aside className="batch-panel card" aria-label="Document">
      <p className="batch-panel-eyebrow" aria-hidden="true">
        Document
      </p>
      <h2 className="batch-panel-title">{item.filename}</h2>
      <p className="muted batch-panel-sub">
        {folder && <span className="mono">{folder}</span>}
        {folder && ' · '}
        {spokenSize(item.sizeBytes)}
      </p>
      <StatusPill {...OUTCOME[item.outcome]} />
      {item.resolution && <p className="conversion-resolution">{RESOLUTION[item.resolution]}</p>}
      {why && whyText ? (
        <div className={`batch-panel-why tone-${OUTCOME[item.outcome].tone}`}>
          <strong>{why}</strong>
          <p>{whyText}</p>
        </div>
      ) : (
        item.detail && <p className="batch-panel-detail">{item.detail}</p>
      )}
      {item.outcome === 'awaiting_review' && (
        <p>
          <ReviewLink item={item} />
        </p>
      )}
      {OUTCOME_NOTE[item.outcome] && <p className="muted">{OUTCOME_NOTE[item.outcome]}</p>}
      {item.rerunIn && (
        <p className="batch-panel-rerun">
          <RerunLink item={item} />
        </p>
      )}
      <dl className="batch-panel-facts">
        {item.startedAt && (
          <>
            <dt>Started</dt>
            <dd>{fileTime(item.startedAt)}</dd>
          </>
        )}
        {item.finishedAt && (
          <>
            <dt>Finished</dt>
            <dd>
              {fileTime(item.finishedAt)}
              {timing ? ` · ${timing}` : ''}
            </dd>
          </>
        )}
        {!item.finishedAt && timing && (
          <>
            <dt>Running</dt>
            <dd>{timing}</dd>
          </>
        )}
        {flagsOf(item) && (
          <>
            <dt>Flags</dt>
            <dd>{flagsOf(item)}</dd>
          </>
        )}
        <dt>Report</dt>
        <dd>
          <button
            type="button"
            className="link"
            aria-label={`Report for ${item.sourceKey}`}
            onClick={onReport}
          >
            View report
          </button>
        </dd>
        <dt>In target</dt>
        <dd>
          {link ? (
            <a href={link} target="_blank" rel="noopener noreferrer">
              Open in the target
            </a>
          ) : isDelivered(item) || item.outcome === 'already_loaded' ? (
            'Delivered'
          ) : (
            'Not created'
          )}
        </dd>
      </dl>
      <div className="batch-panel-actions">
        {canRerun && (
          <button type="button" className="primary" onClick={onRerun}>
            <Icon name="refresh" size={14} /> Re-run this document
          </button>
        )}
        <ItemActions api={api} item={item} onOpen={onOpen} onResult={onResult} />
        <a className="button" href={api.conversionSourceUrl(item.id)} download={item.filename}>
          Download original
        </a>
      </div>
    </aside>
  );
}
