import { useId, useState } from 'react';
import type { AdminIssuedClient } from '@ih/bridge-contract';

/**
 * A client's token, just issued: shown here once, with Copy, and never kept anywhere else. Done
 * (or closing the dialog) drops it; the sink never sends it again.
 */
export function IssuedToken({ issued, onDone }: { issued: AdminIssuedClient; onDone: () => void }) {
  const id = useId();
  const [note, setNote] = useState<string | null>(null);
  const copy = () => {
    // The clipboard API needs a secure context: on plain-HTTP LAN access it doesn't exist.
    if (!navigator.clipboard) {
      setNote('Copying needs HTTPS here: select the token and copy it manually.');
      return;
    }
    navigator.clipboard.writeText(issued.token).then(
      () => setNote('Copied.'),
      () => setNote('Copy failed: select the token and copy it manually.'),
    );
  };
  return (
    <div className="token-panel" role="region" aria-label="New client token">
      <div>
        <strong>Client issued: “{issued.client.name}”</strong>
        <p>Copy the token now. It will not be shown again, here or anywhere else.</p>
      </div>
      <div className="field">
        <label htmlFor={id}>Token</label>
        <div className="token-copy">
          <input
            id={id}
            className="mono"
            readOnly
            value={issued.token}
            onFocus={(e) => e.target.select()}
          />
          <button type="button" aria-label="Copy token" onClick={copy}>
            Copy
          </button>
        </div>
      </div>
      <div className="row-actions">
        <button type="button" className="primary" onClick={onDone}>
          Done
        </button>
      </div>
      {note && <p role="status">{note}</p>}
    </div>
  );
}
