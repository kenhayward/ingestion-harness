import { useCallback, useEffect, useState } from 'react';
import type { AcceptPreview, Item } from '@ih/shared';
import { ApiError, type Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';

const UNDERSTOOD = 'I understand the edits in the target will be overwritten';
const CHANGED_AGAIN = 'This document changed again since you opened this; review the new changes';

/**
 * Accept the target's state (§8, ruling R5): what the refusal says changed in the target, each
 * component with its version then and now, and an explicit confirmation that the next update
 * overwrites those edits. A document that changed again while this was open refuses the
 * confirmation (`stale_preview`), and the new changes are shown to look at again. When it can't
 * be accepted here (too many changes listed, say), it says why and offers detach instead.
 */
export function AcceptDialog({
  api,
  item,
  onClose,
  onAccepted,
  onDetachInstead,
}: {
  api: Api;
  item: Item;
  onClose: () => void;
  onAccepted: (item: Item) => void;
  onDetachInstead: () => void;
}) {
  const [preview, setPreview] = useState<AcceptPreview | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Reading the preview (again, after a stale one): nothing can be confirmed meanwhile. */
  const [reading, setReading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setUnderstood(false);
    setError(null);
    setReading(true);
    api
      .previewAccept(item.id)
      .then(setPreview, (err: Error) => setError(err.message))
      .finally(() => setReading(false));
  }, [api, item.id]);

  useEffect(load, [load]);

  async function accept() {
    if (!preview?.updatedAt) return;
    setBusy(true);
    setError(null);
    try {
      const accepted = await api.acceptTargetState(item.id, preview.updatedAt);
      onAccepted(accepted.item);
      return;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body.code === 'stale_preview') {
        setNotice(CHANGED_AGAIN);
        load(); // the checkbox clears: the new changes must be confirmed afresh
      } else {
        setError((err as Error).message);
      }
    }
    setBusy(false);
  }

  const acceptable = preview?.acceptable === true;
  return (
    <Dialog
      title="Accept the target's state"
      onClose={onClose}
      className="accept-dialog"
      actions={
        preview && !acceptable ? (
          <button type="button" onClick={onDetachInstead}>
            Detach instead
          </button>
        ) : (
          <button
            type="button"
            className="danger"
            disabled={!preview || !understood || busy || reading}
            onClick={() => void accept()}
          >
            Accept and overwrite
          </button>
        )
      }
    >
      <p>
        <span className="mono">{item.sourceKey}</span> was changed in the target since it was last
        delivered. Accepting the target&apos;s state lets the next run of this source update it:{' '}
        <strong>the edits made in the target will be overwritten.</strong>
      </p>
      {notice && (
        <p role="status" className="callout tone-warn">
          {notice}
        </p>
      )}
      {!preview && !error && <p className="muted">Reading the changes…</p>}
      {preview && preview.changed.length > 0 && (
        <table className="memory-table" aria-label="Changed components">
          <thead>
            <tr>
              <th scope="col">Component</th>
              <th scope="col">Version delivered</th>
              <th scope="col">Version now</th>
            </tr>
          </thead>
          <tbody>
            {preview.changed.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.id}</td>
                <td>{c.expected}</td>
                <td>{c.actual ?? <em>removed in the target</em>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {preview && !acceptable && (
        <p role="alert">
          It can&apos;t be accepted here{preview.reason ? `: ${preview.reason}` : ''}.
        </p>
      )}
      {preview && acceptable && (
        <label className="inline">
          <input
            type="checkbox"
            checked={understood}
            disabled={busy || reading}
            onChange={(e) => setUnderstood(e.target.checked)}
          />
          {UNDERSTOOD}
        </label>
      )}
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
