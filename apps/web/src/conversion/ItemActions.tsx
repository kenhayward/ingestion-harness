import { useId, useRef, useState } from 'react';
import { DOCX_MIME, type BatchDetail, type Item, type ItemOutcome } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { AcceptDialog, ChangedNote } from './AcceptDialog.js';
import { OUTCOME } from './outcomes.js';

/** What a row action did, for the batch view to say (and refresh after). */
export interface ActionResult {
  message: string;
  /** The item as the action left it (detach, accept). */
  item?: Item;
  /** Force-load, redeliver and reload start a new batch of one: its id. */
  batchId?: string;
  /** The action was refused or failed: `message` says why. */
  failed?: boolean;
}

/** A row action that asks first, in a dialog the batch view keeps open across its refreshes. */
export type DialogKind = 'redeliver' | 'detach' | 'accept' | 'reload';

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

export const canForce = (item: Item) => FORCEABLE.includes(item.outcome);
export const canRedeliver = (item: Item) =>
  REDELIVERABLE.includes(item.outcome) &&
  item.registerEntryId !== null &&
  item.resolution !== 'detached' &&
  !item.gone;
/** Detach or accept: a document changed in the target that neither has been done to (M7). */
export const canResolve = (item: Item) =>
  item.outcome === 'changed_in_target' && item.registerEntryId !== null && !item.resolution;
/**
 * Load as a new document: the item's `reloadable`, as the route decides it. A document gone from
 * the target (deleted there, say), which no update can reach, or one still detached, so a reload
 * whose rerun failed after its detach can be tried again (owner's call, 2026-10-26).
 */
export const canReload = (item: Item) => item.reloadable;
/**
 * Detach: as `canResolve`, an unresolved document whose versions were never recorded (§8),
 * which no update can be checked against, so there is nothing to accept, or one gone from the
 * target.
 */
export const canDetach = (item: Item) =>
  canResolve(item) ||
  (item.gone && item.registerEntryId !== null && !item.resolution) ||
  (item.outcome === 'unresolved' &&
    item.unversioned &&
    item.registerEntryId !== null &&
    !item.resolution);

const APPLIES: Record<DialogKind, (item: Item) => boolean> = {
  redeliver: canRedeliver,
  detach: canDetach,
  accept: canResolve,
  reload: canReload,
};

/** How the item stands now, when a refresh moved it on while its dialog was open. */
function changedNote(kind: DialogKind, item: Item): string | null {
  if (APPLIES[kind](item)) return null;
  const now =
    item.resolution === 'accepted'
      ? "the target's state was accepted"
      : item.resolution === 'detached'
        ? 'it was detached'
        : item.resolution === 'superseded'
          ? 'a later run superseded it'
          : `it is now ${OUTCOME[item.outcome].label.toLowerCase()}`;
  return `This document changed while this was open: ${now}.`;
}

/**
 * A conversion item's row actions, each offered only where it applies: force-load, redeliver
 * (optionally from a replacement file), and for a document changed in the target, detach or
 * accept the target's state (§8, "Resolving a refused document"); for an unresolved document
 * whose versions were never recorded, detach only; for one gone from the target, load as a new
 * document, or detach. Once one of those is done the item's
 * `resolution` says so, and neither is offered again. Each button names its document.
 */
export function ItemActions({
  api,
  item,
  onOpen,
  onResult,
}: {
  api: Api;
  item: Item;
  onOpen: (kind: DialogKind) => void;
  onResult: (result: ActionResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  /** Set from the first click until the request settles, before a render can disable it. */
  const sending = useRef(false);

  async function forceLoad() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    await api
      .forceConversionItem(item.id)
      .then(rerunDone(item, onResult, 'Force-load'), (err) =>
        onResult(failed(item, 'Force-load', err as Error)),
      );
    sending.current = false;
    setBusy(false);
  }

  const key = item.sourceKey;
  return (
    <>
      {canForce(item) && (
        <button
          type="button"
          disabled={busy}
          aria-label={`Force-load ${key}`}
          onClick={() => void forceLoad()}
        >
          Force-load
        </button>
      )}
      {canRedeliver(item) && (
        <button
          type="button"
          disabled={busy}
          aria-label={`Redeliver ${key}`}
          onClick={() => onOpen('redeliver')}
        >
          Redeliver
        </button>
      )}
      {canReload(item) && (
        <button
          type="button"
          disabled={busy}
          aria-label={`Load ${key} as a new document`}
          onClick={() => onOpen('reload')}
        >
          Load as a new document
        </button>
      )}
      {canResolve(item) && (
        <button
          type="button"
          disabled={busy}
          aria-label={`Accept the target's state for ${key}`}
          onClick={() => onOpen('accept')}
        >
          Accept the target&apos;s state
        </button>
      )}
      {canDetach(item) && (
        <button
          type="button"
          disabled={busy}
          aria-label={`Detach ${key}`}
          onClick={() => onOpen('detach')}
        >
          Detach
        </button>
      )}
    </>
  );
}

const rerunDone =
  (item: Item, onResult: (r: ActionResult) => void, what: string) => (detail: BatchDetail) =>
    onResult({
      message: `${what} started a new batch for ${item.sourceKey}.`,
      batchId: detail.batch.id,
    });
const failed = (item: Item, what: string, err: Error): ActionResult => ({
  message: `${what} of ${item.sourceKey} failed: ${err.message}`,
  failed: true,
});

/**
 * The open dialog of one row action. `item` is the item as last read, so a refresh that moves
 * it on (another person resolved it, say) keeps the dialog open and says what changed.
 */
export function ItemDialog({
  api,
  item,
  kind,
  onClose,
  onSwitch,
  onResult,
}: {
  api: Api;
  item: Item;
  kind: DialogKind;
  onClose: () => void;
  onSwitch: (kind: DialogKind) => void;
  onResult: (result: ActionResult) => void;
}) {
  const note = changedNote(kind, item);
  if (kind === 'redeliver') {
    return (
      <RedeliverDialog
        api={api}
        item={item}
        note={note}
        onClose={onClose}
        onDone={(detail) => {
          onClose();
          rerunDone(item, onResult, 'Redeliver')(detail);
        }}
      />
    );
  }
  if (kind === 'reload') {
    return (
      <ReloadDialog
        api={api}
        item={item}
        note={note}
        onClose={onClose}
        onDone={(detail) => {
          onClose();
          rerunDone(item, onResult, 'Load as a new document')(detail);
        }}
      />
    );
  }
  if (kind === 'detach') {
    return (
      <DetachDialog
        api={api}
        item={item}
        note={note}
        onClose={onClose}
        onDone={(detached) => {
          onClose();
          onResult({ message: `${item.sourceKey} was detached.`, item: detached });
        }}
      />
    );
  }
  return (
    <AcceptDialog
      api={api}
      item={item}
      note={note}
      onClose={onClose}
      onAccepted={(accepted) => {
        onClose();
        onResult({
          message: `The target's state was accepted for ${item.sourceKey}.`,
          item: accepted,
        });
      }}
      onDetachInstead={() => onSwitch('detach')}
    />
  );
}

/** Redeliver: the stored file again, or a replacement that keeps the item's source key (R6). */
function RedeliverDialog({
  api,
  item,
  note,
  onClose,
  onDone,
}: {
  api: Api;
  item: Item;
  note: string | null;
  onClose: () => void;
  onDone: (detail: BatchDetail) => void;
}) {
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);

  async function redeliver() {
    if (sending.current) return;
    sending.current = true;
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
    sending.current = false;
  }

  return (
    <Dialog
      title={`Redeliver ${item.sourceKey}`}
      onClose={onClose}
      actions={
        <button
          type="button"
          className="primary"
          disabled={busy || note !== null}
          onClick={() => void redeliver()}
        >
          Redeliver
        </button>
      }
    >
      <p>
        Updates this document in the target as an explicit update, in a new batch of one. The
        target&apos;s version check still applies: edits made in the target are not overwritten.
      </p>
      <ChangedNote note={note} />
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

/**
 * Load as a new document: the target no longer has the document, so CT Studio detaches it and
 * creates it again from the stored file, in a new batch of one.
 */
function ReloadDialog({
  api,
  item,
  note,
  onClose,
  onDone,
}: {
  api: Api;
  item: Item;
  note: string | null;
  onClose: () => void;
  onDone: (detail: BatchDetail) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);

  async function reload() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.reloadConversionItem(item.id));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
    sending.current = false;
  }

  return (
    <Dialog
      title={`Load ${item.sourceKey} as a new document?`}
      onClose={onClose}
      actions={
        <button
          type="button"
          className="primary"
          disabled={busy || note !== null}
          onClick={() => void reload()}
        >
          Load as a new document
        </button>
      }
    >
      <p>
        This creates a new document in the target from the stored file of{' '}
        <span className="mono">{item.sourceKey}</span>, in a new batch of one. The old document no
        longer exists there: it may have been deleted, so its links and history in the target
        don&apos;t carry over.
      </p>
      <ChangedNote note={note} />
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}

/** Detach (§8): CT Studio forgets the document; it stays in the target, untouched. */
function DetachDialog({
  api,
  item,
  note,
  onClose,
  onDone,
}: {
  api: Api;
  item: Item;
  note: string | null;
  onClose: () => void;
  onDone: (item: Item) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);

  async function detach() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.detachConversionItem(item.id));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
    sending.current = false;
  }

  return (
    <Dialog
      title={`Detach ${item.sourceKey}?`}
      onClose={onClose}
      actions={
        <button
          type="button"
          className="danger"
          disabled={busy || note !== null}
          onClick={() => void detach()}
        >
          Detach
        </button>
      }
    >
      {item.gone ? (
        <p>
          CT Studio forgets this document, which the target no longer has. The next run of{' '}
          <span className="mono">{item.sourceKey}</span> creates a new document of its own.
        </p>
      ) : (
        <p>
          CT Studio forgets this document. The document stays in the target, untouched, with the
          edits made there. The next run of <span className="mono">{item.sourceKey}</span> creates a
          new document of its own.
        </p>
      )}
      <ChangedNote note={note} />
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
