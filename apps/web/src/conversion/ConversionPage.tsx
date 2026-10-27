import { useEffect, useState } from 'react';
import { ITEM_OUTCOMES, type BatchSummary, type ConversionTarget } from '@ih/shared';
import type { Api } from '../api/client.js';
import { StatusGlyph } from '../jobs/JobStatusIcon.js';
import { navigate } from '../router.js';
import { Avatar } from '../shell/Avatar.js';
import { HelpButton } from '../ui/Help.js';
import { Icon } from '../ui/Icon.js';
import { BatchView } from './BatchView.js';
import { NewBatch } from './NewBatch.js';
import { OUTCOME, batchState } from './outcomes.js';

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

/** The batches started before, newest first, a page at a time, each a link to its view. */
function EarlierBatches({ api }: { api: Api }) {
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);
  const [targets, setTargets] = useState<ConversionTarget[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

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
            <col className="when-col" />
            <col />
            <col className="docs-col" />
            <col className="outcomes-col" />
            <col className="by-col" />
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
                    if (!(e.target as HTMLElement).closest('a')) navigate(href);
                  }}
                >
                  <td className="status-cell">
                    <StatusGlyph {...state} />
                  </td>
                  <td className="when-cell">
                    <a href={href} title={fullWhen(b.createdAt)}>
                      {batchDay(b.createdAt)}
                    </a>
                  </td>
                  <td className="target-cell">
                    {target ? `${target.label} · ${target.sinkName}` : b.targetId}
                    {b.force && <span className="force-tag">Force-load</span>}
                  </td>
                  <td className="docs-cell">{plural(b.itemCount, 'doc')}</td>
                  <td className="outcomes-cell">
                    <OutcomeChips batch={b} />
                  </td>
                  <td className="by-cell">
                    {b.createdBy.name && (
                      <>
                        <Avatar name={b.createdBy.name} />
                        {b.createdBy.name}
                      </>
                    )}
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
    </section>
  );
}
