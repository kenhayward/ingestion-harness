import { useEffect, useState, type ReactNode } from 'react';
import type { DraftRun, DraftStage } from '@ih/shared';
import { Icon } from '../ui/Icon.js';
import { draftRunView } from './draft-run.js';

/** Now, moved on every second while mounted: the run's times count up between polls. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * What a queued or running drafting stage is doing (issue #151): its phases, done, current or
 * still to come, the current one's detail and time, and the whole run's time. Without a run
 * (an older API) it shows `fallback`.
 */
export function DraftRunProgress({
  stage,
  run,
  label,
  fallback,
  onCancel,
  cancelling = false,
}: {
  stage: DraftStage;
  run: DraftRun | null;
  /** The group's name, e.g. "Survey progress". */
  label: string;
  fallback: ReactNode;
  /** Given: a Cancel run button (waiting or running runs). */
  onCancel?: () => void;
  /** A cancel (or another action) is in flight: the button waits. */
  cancelling?: boolean;
}) {
  const now = useNow();
  const cancel = onCancel && (
    <button type="button" className="draft-run-cancel" onClick={onCancel} disabled={cancelling}>
      Cancel run
    </button>
  );
  if (!run) {
    return (
      <>
        {fallback}
        {cancel}
      </>
    );
  }
  const view = draftRunView(stage, run, now);
  return (
    <div role="group" aria-label={label} className="draft-run">
      <p className="draft-run-head">
        <span className="draft-run-pulse" aria-hidden="true" />
        <strong>{view.headline}</strong>
        {cancel}
      </p>
      <ol className="draft-run-phases">
        {view.phases.map((p) => (
          <li
            key={p.key}
            className={`draft-phase ${p.state}`}
            aria-current={p.state === 'current' ? 'step' : undefined}
          >
            <span className="draft-phase-mark" aria-hidden="true">
              {p.state === 'done' && <Icon name="check" size={14} />}
            </span>
            <span className="draft-phase-text">
              <span className="draft-phase-label">
                {p.label}
                {p.elapsed && <span className="muted"> · {p.elapsed}</span>}
              </span>
              {p.detail && <small className="muted">{p.detail}</small>}
            </span>
            {p.state === 'done' && <span className="visually-hidden">(done)</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
