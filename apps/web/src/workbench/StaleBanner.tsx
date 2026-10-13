import type { ReactNode } from 'react';
import { StageStatusIcon } from '../ui/StageStatusIcon.js';

/**
 * Handoff §0.4 (stale) and SV1 (a skip being replaced, `skip` tone): a tab whose inputs changed
 * names what changed; Keep and Propose again.
 */
export function StaleBanner({
  children,
  tone = 'alert',
  onKeep,
  keepLabel = 'Keep',
  onPropose,
  busy = false,
}: {
  children: ReactNode;
  tone?: 'alert' | 'info' | 'skip';
  onKeep?: () => void;
  keepLabel?: string;
  onPropose?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="stale-banner" role="note" data-tone={tone}>
      {tone === 'alert' && <StageStatusIcon state="stale" size={18} />}
      {tone === 'skip' && <StageStatusIcon state="skipped" size={18} decorative />}
      <p className="stale-banner-text">{children}</p>
      {(onKeep || onPropose) && (
        <div className="stale-banner-actions">
          {onKeep && (
            <button type="button" disabled={busy} onClick={onKeep}>
              {keepLabel}
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
