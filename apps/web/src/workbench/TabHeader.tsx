import { createContext, useContext, type ReactNode } from 'react';
import type { OverviewItem } from '@ih/shared';
import type { HelpTopicId } from '../help/topics.js';
import { HelpButton } from '../ui/Help.js';
import { StageStatusIcon } from '../ui/StageStatusIcon.js';
import { stageStyle, TONE_COLOR } from '../ui/stageStyle.js';

/** The open project tab's help topic (ProjectPage provides it): TabHeader puts its ? last. */
export const TabHelpTopic = createContext<HelpTopicId | null>(null);

/** Every project tab's header (handoff §4): H2, status icon + text in tone, a note, actions, then
 * the tab's help at the top right. */
export function TabHeader({
  title,
  item,
  description,
  note,
  actions,
}: {
  title: string;
  item: OverviewItem | null;
  description?: string;
  note?: string;
  actions?: ReactNode;
}) {
  const showStatus = item !== null && item.state !== 'none';
  const topic = useContext(TabHelpTopic);
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
        {description && <p className="muted tab-note">{description}</p>}
        {note && <p className="muted tab-note">{note}</p>}
      </div>
      {(actions || topic) && (
        <div className="tab-actions">
          {actions}
          {topic && <HelpButton topic={topic} />}
        </div>
      )}
    </header>
  );
}
