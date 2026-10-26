import { useEffect, useRef, useState } from 'react';
import type { BatchDetail, ConversionTarget, Item } from '@ih/shared';
import { ApiError, type Api } from '../api/client.js';
import { navigate } from '../router.js';
import { FilterChips, type FilterChip } from '../ui/FilterChips.js';
import { StatusPill } from '../ui/StatusPill.js';
import { ItemActions, ItemDialog, type ActionResult, type DialogKind } from './ItemActions.js';
import {
  OUTCOME,
  OUTCOME_NOTE,
  RESOLUTION,
  isDone,
  isUnfinished,
  needsAttention,
} from './outcomes.js';
import { ReportPanel } from './ReportPanel.js';

/** How often the view reads the batch again while anything in it is unfinished. */
export const BATCH_POLL_MS = 3000;

type Filter = 'all' | 'attention' | 'done';
const FILTERS: Record<Filter, (item: Item) => boolean> = {
  all: () => true,
  attention: needsAttention,
  done: isDone,
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
/** A link the target gave is followed only when it is a web address. */
const webLink = (link: string | null) => (link && /^https?:\/\//i.test(link) ? link : null);

/**
 * The progress said to assistive technology: how many documents are done, and how many need
 * a look.
 */
function progressOf(items: Item[]): string {
  const total = items.length;
  const left = items.filter(isUnfinished).length;
  const attention = items.filter(needsAttention).length;
  const done =
    left === 0
      ? `All ${plural(total, 'document')} done`
      : `${total - left} of ${plural(total, 'document')} done`;
  return attention ? `${done}; ${attention} ${attention === 1 ? 'needs' : 'need'} attention` : done;
}

/**
 * One conversion batch (decomposition phase 3): a row per document with its outcome (§3), its
 * detail, its link in the target and its report, and the row actions that apply. It reads the
 * batch again every few seconds while any document is queued, decomposing or delivering (a
 * `decompose` job has no live events of its own here), and stops once none is; a first read that
 * fails is tried again on the same beat. Each time the number of unfinished documents changes, a
 * polite status says how far it has got. A started batch carries on without the page, so
 * `#/conversion/<batchId>` picks it up after a reload. A row action's dialog is kept here, so a
 * refresh that moves its row (out of the filter, say) leaves it open, saying what changed.
 */
export function BatchView({
  api,
  batchId,
  pollMs = BATCH_POLL_MS,
}: {
  api: Api;
  batchId: string;
  pollMs?: number;
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
  const target = targets.find((t) => t.id === batch.targetId)?.label ?? batch.targetId;
  const shown = items.filter(FILTERS[filter]);
  /** The item of the open dialog, as last read (all items: the filter may hide its row). */
  const open = dialog ? items.find((i) => i.id === dialog.itemId) : undefined;
  const chips: FilterChip<Filter>[] = [
    { value: 'all', label: 'All', count: items.length },
    {
      value: 'attention',
      label: 'Needs attention',
      count: items.filter(needsAttention).length,
      tone: 'warn',
    },
    { value: 'done', label: 'Done', count: items.filter(isDone).length },
  ];

  return (
    <section className="card batch-view" aria-labelledby="batch-heading">
      <div className="batch-view-head">
        <div>
          <h2 className="section-heading" id="batch-heading">
            Batch
          </h2>
          <p className="muted">
            {plural(items.length, 'document')} to {target}
            {batch.startedAt ? `, started ${when(batch.startedAt)}` : ''}
            {batch.force ? ', force-loaded' : ''}
            {batch.createdBy.name ? ` by ${batch.createdBy.name}` : ''}
          </p>
        </div>
        <a href="#/conversion">New batch</a>
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

      <FilterChips label="Show" chips={chips} value={filter} onChange={setFilter} />

      {shown.length === 0 ? (
        <p className="muted">
          {filter === 'attention' ? 'Nothing needs attention.' : 'No document here yet.'}
        </p>
      ) : (
        <div className="batch-table-wrap">
          <table className="memory-table batch-table" aria-label="Documents">
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Outcome</th>
                <th scope="col">Detail</th>
                <th scope="col">
                  <span className="visually-hidden">Links and actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => {
                const link = webLink(item.link);
                return (
                  <tr key={item.id}>
                    <td>
                      <span className="mono">{item.sourceKey}</span>
                    </td>
                    <td>
                      <StatusPill {...OUTCOME[item.outcome]} />
                    </td>
                    <td>
                      {item.resolution && (
                        <p className="conversion-resolution">{RESOLUTION[item.resolution]}</p>
                      )}
                      {item.detail}
                      {OUTCOME_NOTE[item.outcome] && (
                        <p className="muted conversion-hint-tight">{OUTCOME_NOTE[item.outcome]}</p>
                      )}
                    </td>
                    <td>
                      <span className="conversion-actions">
                        {link && (
                          <a href={link} target="_blank" rel="noopener noreferrer">
                            Open in the target
                          </a>
                        )}
                        <button
                          type="button"
                          className="link"
                          aria-label={`Report for ${item.sourceKey}`}
                          onClick={() => setReport(item)}
                        >
                          Report
                        </button>
                        <ItemActions
                          api={api}
                          item={item}
                          onOpen={(kind) => setDialog({ itemId: item.id, kind })}
                          onResult={acted}
                        />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

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
    </section>
  );
}
