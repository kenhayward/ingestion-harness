import { useState } from 'react';
import type { TestRun } from '@ih/shared';
import { ApiError } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';

/** What a cancel asks about: one run (its row) or a batch's queued and running runs. */
export interface CancelRequest {
  runs: readonly TestRun[];
  batch: boolean;
}

/**
 * Confirms and cancels test runs one by one. A run that finished meanwhile (409) counts as done;
 * any other refusal is listed and the dialog stays open. Closes once every run is cancelled.
 */
export function CancelRunsDialog({
  request,
  cancel,
  onDone,
  onClose,
}: {
  request: CancelRequest;
  cancel: (id: string) => Promise<unknown>;
  /** At least one run was asked to cancel: the tab reloads and tells the page. */
  onDone: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const { runs, batch } = request;
  const n = runs.length;
  const many = `${n} run${n === 1 ? '' : 's'}`;
  const title = batch ? `Cancel ${many} in this batch?` : `Cancel the run of ${runs[0]?.filename}?`;

  const confirm = async () => {
    setBusy(true);
    const failed: string[] = [];
    for (const run of runs) {
      try {
        await cancel(run.id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) continue; // it finished meanwhile
        failed.push(`Could not cancel ${run.filename}: ${(err as Error).message}`);
      }
    }
    setBusy(false);
    onDone();
    if (failed.length === 0) onClose();
    else setFailures(failed);
  };

  return (
    <Dialog
      title={title}
      onClose={onClose}
      closeLabel="Keep running"
      actions={
        <button type="button" className="danger" disabled={busy} onClick={() => void confirm()}>
          {batch ? `Cancel ${many}` : 'Cancel run'}
        </button>
      }
    >
      {batch && <p>{runs.map((run) => run.filename).join(', ')}</p>}
      <p>
        A running run stops at its next safe point; runs that already finished are not touched. You
        can retry a cancelled run.
      </p>
      {failures.length > 0 && (
        <div role="alert">
          {failures.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </Dialog>
  );
}
