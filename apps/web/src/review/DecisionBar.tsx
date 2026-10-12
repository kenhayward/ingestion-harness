import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon.js';

/**
 * Decision bar (UI handoff §2), sticky at the bottom: approve with an optional note, or Reject…
 * which asks for the (required, final) reason in place of the note.
 */
export function DecisionBar({
  busy,
  reviewer,
  onReviewer,
  onApprove,
  onReject,
}: {
  busy: boolean;
  reviewer: string;
  onReviewer: (name: string) => void;
  onApprove: (note: string) => void;
  onReject: (reason: string) => void;
}) {
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const reasonRef = useRef<HTMLInputElement>(null);
  const rejectButton = useRef<HTMLButtonElement>(null);
  const [returnFocus, setReturnFocus] = useState(false);

  useEffect(() => {
    if (rejecting) reasonRef.current?.focus();
    else if (returnFocus) {
      rejectButton.current?.focus();
      setReturnFocus(false);
    }
  }, [rejecting, returnFocus]);

  return (
    // A group, not a form: Enter in a field must never approve or reject (both are final).
    <div className="decision-bar" role="group" aria-label="Decision">
      <label className="field reviewer">
        Reviewer
        <input value={reviewer} onChange={(e) => onReviewer(e.target.value)} />
      </label>
      {rejecting ? (
        <>
          <label className="field grow">
            Rejection reason (required — rejecting is final)
            <input
              ref={reasonRef}
              className="danger-border"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              setRejecting(false);
              setReason('');
              setReturnFocus(true);
            }}
          >
            Keep reviewing
          </button>
          <button
            type="button"
            className="danger-fill"
            disabled={busy || !reason.trim()}
            onClick={() => onReject(reason.trim())}
          >
            Reject document
          </button>
        </>
      ) : (
        <>
          <label className="field grow">
            Note (optional)
            <input
              value={note}
              placeholder="e.g. Corrected PO number from page 1"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <button
            ref={rejectButton}
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => setRejecting(true)}
          >
            Reject…
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => onApprove(note.trim())}
          >
            <Icon name="check" />
            Approve and publish
          </button>
        </>
      )}
    </div>
  );
}
