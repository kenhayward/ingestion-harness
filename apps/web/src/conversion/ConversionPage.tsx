import { useEffect, useState } from 'react';
import { ITEM_OUTCOMES, type BatchSummary, type ConversionTarget } from '@ih/shared';
import type { Api } from '../api/client.js';
import { HelpButton } from '../ui/Help.js';
import { BatchView } from './BatchView.js';
import { NewBatch } from './NewBatch.js';
import { OUTCOME } from './outcomes.js';

/**
 * The Conversion tab (decomposition phase 3): Word documents converted in batches and delivered
 * to a target that takes documents. Operators, designers and admins all use it (ruling R1).
 * `#/conversion` starts a new batch and lists the earlier ones; `#/conversion/<batchId>` shows
 * one.
 */
export function ConversionPage({ api, batchId }: { api: Api; batchId?: string }) {
  return (
    <div className="conversion-page">
      <div className="page-header">
        <div>
          <h1>Conversion</h1>
          <p className="muted">
            Convert Word documents, one file or a whole folder at a time, and deliver each as a
            document of its own to a target that takes them.
          </p>
        </div>
        <div className="page-header-actions">
          <HelpButton topic="conversion" />
        </div>
      </div>
      {batchId ? (
        <BatchView api={api} batchId={batchId} />
      ) : (
        <>
          <NewBatch api={api} />
          <EarlierBatches api={api} />
        </>
      )}
    </div>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A batch's counts in outcome order, the outcomes it has only ("2 created · 1 failed"). */
const countsOf = (b: BatchSummary) =>
  ITEM_OUTCOMES.filter((o) => (b.counts[o] ?? 0) > 0)
    .map((o) => `${b.counts[o]} ${OUTCOME[o].label.toLowerCase()}`)
    .join(' · ');

/** The batches started before, newest first, each a link to its view. */
function EarlierBatches({ api }: { api: Api }) {
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);
  const [targets, setTargets] = useState<ConversionTarget[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listConversionBatches().then(
      (list) => setBatches([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
      (err: Error) => setError(err.message),
    );
    api.listConversionTargets().then(setTargets, () => undefined); // labels only: ids will do
  }, [api]);

  if (!error && !batches?.length) return null;
  return (
    <section className="card" aria-labelledby="earlier-batches">
      <h2 className="section-heading" id="earlier-batches">
        Earlier batches
      </h2>
      {error && <p role="alert">The earlier batches could not be read: {error}</p>}
      {batches && batches.length > 0 && (
        <ul className="upload-list" aria-label="Earlier batches">
          {batches.map((b) => (
            <li key={b.id}>
              <a href={`#/conversion/${encodeURIComponent(b.id)}`}>{when(b.createdAt)}</a>
              <span>
                {targets.find((t) => t.id === b.targetId)?.label ?? b.targetId} ·{' '}
                {plural(b.itemCount, 'document')}
                {b.state === 'open' ? ' · never started' : ''}
                {b.state === 'discarded' ? ' · discarded' : ''}
              </span>
              <span className="muted">{countsOf(b)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
