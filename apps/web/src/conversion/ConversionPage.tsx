import type { Api } from '../api/client.js';
import { HelpButton } from '../ui/Help.js';
import { NewBatch } from './NewBatch.js';

/**
 * The Conversion tab (decomposition phase 3): Word documents converted in batches and delivered
 * to a target that takes documents. Operators, designers and admins all use it (ruling R1).
 * `#/conversion` starts a new batch; `#/conversion/<batchId>` shows one.
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
      {batchId ? <BatchPlaceholder batchId={batchId} /> : <NewBatch api={api} />}
    </div>
  );
}

/** Where the batch view goes (its rows, outcomes and actions come next). */
function BatchPlaceholder({ batchId }: { batchId: string }) {
  return (
    <section className="card" aria-label="Batch">
      <h2 className="section-heading">Batch started</h2>
      <p>
        Batch <span className="mono">{batchId}</span> has started: each document is converted and
        delivered on its own.
      </p>
      <a href="#/conversion">New batch</a>
    </section>
  );
}
