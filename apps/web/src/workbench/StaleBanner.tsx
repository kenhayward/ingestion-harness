import type { ReactNode } from 'react';
import { StageStatusIcon } from '../ui/StageStatusIcon.js';

/** Handoff §0.4: a tab whose inputs changed names what changed; Keep and Propose again. */
export function StaleBanner({
  children,
  tone = 'alert',
  onKeep,
  onPropose,
  busy = false,
}: {
  children: ReactNode;
  tone?: 'alert' | 'info';
  onKeep?: () => void;
  onPropose?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="stale-banner" role="note" data-tone={tone}>
      {tone === 'alert' && <StageStatusIcon state="stale" size={18} />}
      <p className="stale-banner-text">{children}</p>
      {(onKeep || onPropose) && (
        <div className="stale-banner-actions">
          {onKeep && (
            <button type="button" disabled={busy} onClick={onKeep}>
              Keep
            </button>
          )}
          {onPropose && (
            <button type="button" disabled={busy} onClick={onPropose}>
              Propose again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
