import { useId, useState } from 'react';
import { DOCX_MIME, type BatchDetail, type Item, type ItemOutcome } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { AcceptDialog } from './AcceptDialog.js';
import { resolutionOf } from './outcomes.js';

/** What a row action did, for the batch view to say (and refresh after). */
export interface ActionResult {
  message: string;
  /** The item as the action left it (detach, accept). */
  item?: Item;
  /** Force-load and redeliver start a new batch of one: its id. */
  batchId?: string;
  /** The action was refused or failed: `message` says why. */
  failed?: boolean;
}

/** Force-load (§8): an already loaded document is updated, a duplicate created on its own. */
const FORCEABLE: readonly ItemOutcome[] = ['already_loaded', 'duplicate'];

/**
 * Redeliver (R6): a delivered or refused document that has a register entry. A duplicate's entry
 * is another source's, so it has none of its own (force-load it instead).
 */
const REDELIVERABLE: readonly ItemOutcome[] = [
  'created',
  'updated',
  'read_back_mismatch',
  'already_loaded',
  'changed_in_target',
  'unresolved',
];

/**
 * A conversion item's row actions, each offered only where it applies: force-load, redeliver
 * (optionally from a replacement file), and for a document changed in the target, detach or
 * accept the target's state (§8, "Resolving a refused document"). Once one of those two is done
 * the item stays changed in the target (M7), and neither is offered again.
 */
export function ItemActions({
  api,
  item,
  onResult,
}: {
  api: Api;
  item: Item;
  onResult: (result: ActionResult) => void;
}) {
  const [open, setOpen] = useState<'redeliver' | 'detach' | 'accept' | null>(null);
  const [busy, setBusy] = useState(false);
  const resolved = resolutionOf(item);
  const canForce = FORCEABLE.includes(item.outcome);
  const canRedeliver =
    REDELIVERABLE.includes(item.outcome) &&
    item.registerEntryId !== null &&
    resolved !== 'detached';
  const canResolve = item.outcome === 'changed_in_target' && resolved === null;

  const rerunDone = (what: string) => (detail: BatchDetail) =>
    onResult({
      message: `${what} started a new batch for ${item.sourceKey}.`,
      batchId: detail.batch.id,
    });
  const failed = (what: string) => (err: Error) =>
    onResult({ message: `${what} of ${item.sourceKey} failed: ${err.message}`, failed: true });

  async function forceLoad() {
    setBusy(true);
    await api.forceConversionItem(item.id).then(rerunDone('Force-load'), failed('Force-load'));
    setBusy(false);
  }

  if (!canForce && !canRedeliver && !canResolve) return null;
  return (
    <>
      {canForce && (
        <button type="button" disabled={busy} onClick={() => void forceLoad()}>
          Force-load
        </button>
      )}
      {canRedeliver && (
        <button type="button" disabled={busy} onClick={() => setOpen('redeliver')}>
          Redeliver
        </button>
      )}
      {canResolve && (
        <>
          <button type="button" disabled={busy} onClick={() => setOpen('accept')}>
            Accept the target&apos;s state
          </button>
          <button type="button" disabled={busy} onClick={() => setOpen('detach')}>
            Detach
          </button>
        </>
      )}
      {open === 'redeliver' && (
        <RedeliverDialog
          api={api}
          item={item}
          onClose={() => setOpen(null)}
          onDone={(detail) => {
            setOpen(null);
            rerunDone('Redeliver')(detail);
          }}
        />
      )}
      {open === 'detach' && (
        <DetachDialog
          api={api}
          item={item}
          onClose={() => setOpen(null)}
          onDone={(detached) => {
            setOpen(null);
            onResult({ message: `${item.sourceKey} was detached.`, item: detached });
          }}
        />
      )}
      {open === 'accept' && (
        <AcceptDialog
          api={api}
          item={item}
          onClose={() => setOpen(null)}
          onAccepted={(accepted) => {
            setOpen(null);
            onResult({
              message: `The target's state was accepted for ${item.sourceKey}.`,
              item: accepted,
            });
          }}
          onDetachInstead={() => setOpen('detach')}
        />
      )}
    </>
  );
}

/** Redeliver: the stored file again, or a replacement that keeps the item's source key (R6). */
function RedeliverDialog({
  api,
  item,
  onClose,
  onDone,
}: {
  api: Api;
  item: Item;
  onClose: () => void;
  onDone: (detail: BatchDetail) => void;
}) {
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function redeliver() {
    setBusy(true);
    setError(null);
    try {
      onDone(
        await (file
          ? api.redeliverConversionItem(item.id, file)
          : api.redeliverConversionItem(item.id)),
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Redeliver ${item.sourceKey}`}
      onClose={onClose}
      actions={
        <button type="button" className="primary" disabled={busy} onClick={() => void redeliver()}>
          Redeliver
        </button>
      }
    >
      <p>
        Updates this document in the target as an explicit update, in a new batch of one. The
        target&apos;s version check still applies: edits made in the target are not overwritten.
      </p>
      <label className="field" htmlFor={fileId}>
        Replacement file (optional)
      </label>
      <input
        id={fileId}
        type="file"
        accept={['.docx', DOCX_MIME].join(',')}
        disabled={busy}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <p className="muted conversion-hint-tight">
        Without one, the stored file is delivered again. A replacement keeps the name{' '}
        <span className="mono">{item.sourceKey}</span>, so it updates the same document.
      </p>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}

/** Detach (§8): CT Studio forgets the document; it stays in the target, untouched. */
function DetachDialog({
  api,
  item,
  onClose,
  onDone,
}: {
  api: Api;
  item: Item;
  onClose: () => void;
  onDone: (item: Item) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function detach() {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.detachConversionItem(item.id));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Detach ${item.sourceKey}?`}
      onClose={onClose}
      actions={
        <button type="button" className="danger" disabled={busy} onClick={() => void detach()}>
          Detach
        </button>
      }
    >
      <p>
        CT Studio forgets this document. The document stays in the target, untouched, with the edits
        made there. The next run of <span className="mono">{item.sourceKey}</span> creates a new
        document of its own.
      </p>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
