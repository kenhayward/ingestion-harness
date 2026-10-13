import type { ReactNode } from 'react';
import type { OverviewItem } from '@ih/shared';
import { StageStatusIcon } from '../ui/StageStatusIcon.js';
import { stageStyle, TONE_COLOR } from '../ui/stageStyle.js';

/** Every project tab's header (handoff §4): H2, status icon + text in tone, a note, actions. */
export function TabHeader({
  title,
  item,
  note,
  actions,
}: {
  title: string;
  item: OverviewItem | null;
  note?: string;
  actions?: ReactNode;
}) {
  const showStatus = item !== null && item.state !== 'none';
  return (
    <header className="tab-header">
      <div className="tab-header-text">
        <h2>{title}</h2>
        {showStatus && (
          <p className="tab-status" style={{ color: TONE_COLOR[stageStyle(item.state).tone] }}>
            <StageStatusIcon state={item.state} size={18} decorative />
            {item.status}
          </p>
        )}
        {note && <p className="muted tab-note">{note}</p>}
      </div>
      {actions && <div className="tab-actions">{actions}</div>}
    </header>
  );
}
