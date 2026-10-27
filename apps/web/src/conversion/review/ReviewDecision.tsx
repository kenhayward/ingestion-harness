import { useState } from 'react';
import { Icon } from '../../ui/Icon.js';

/**
 * The decision bar of a held PDF (the extraction review's look): Approve, with an optional note,
 * or Reject, which needs the note. Once someone else has decided, it says so and links back.
 */
export function ReviewDecision({
  busy,
  error,
  decided,
  batchHref,
  onApprove,
  onReject,
}: {
  busy: boolean;
  error: string | null;
  /** Someone else approved or rejected the document first (a 409). */
  decided: boolean;
  batchHref: string;
  onApprove: (note: string | undefined) => void;
  onReject: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    // A group, not a form: Enter in the note must never approve or reject (both are final).
    <div className="decision-bar" role="group" aria-label="Decision">
      {decided ? (
        <p role="alert">
          Someone else has already decided this document. <a href={batchHref}>Back to the batch</a>
        </p>
      ) : (
        <>
          {error && <p role="alert">{error}</p>}
          <label className="field grow">
            Note (optional to approve, required to reject)
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button
            type="button"
            className="danger"
            disabled={busy || !note.trim()}
            onClick={() => onReject(note.trim())}
          >
            Reject
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => onApprove(note.trim() || undefined)}
          >
            <Icon name="check" />
            Approve
          </button>
        </>
      )}
    </div>
  );
}
