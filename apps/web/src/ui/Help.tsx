import { createContext, useContext, useState, type ReactNode } from 'react';
import { HELP_TOPICS, type HelpTopicId } from '../help/topics.js';
import { Dialog } from './Dialog.js';
import { Icon } from './Icon.js';

/**
 * Opens the account menu's Help dialog at a topic (App provides it); without it, a ? dialog
 * offers no Open in Help.
 */
export const HelpCenterContext = createContext<((topic: HelpTopicId) => void) | null>(null);

/**
 * A "?" beside a heading that opens the topic's explanation in a modal (Close, Escape or a click
 * outside closes it; focus returns to the button). Topics live in `help/topics.tsx`: add one
 * there and put `<HelpButton topic="…" />` where it is needed.
 */
export function HelpButton({ topic }: { topic: HelpTopicId }) {
  const [open, setOpen] = useState(false);
  const openHelp = useContext(HelpCenterContext);
  const { title, body } = HELP_TOPICS[topic];
  return (
    <>
      <button
        type="button"
        className="help-button"
        aria-label={`Help: ${title}`}
        title={title}
        onClick={() => setOpen(true)}
      >
        <Icon name="help" size={16} />
      </button>
      {open && (
        <Dialog
          title={title}
          icon={<Icon name="help" size={28} strokeWidth={1.6} />}
          closeLabel="Close"
          className="help-dialog"
          onClose={() => setOpen(false)}
          actions={
            openHelp && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  openHelp(topic);
                }}
              >
                Open in Help
              </button>
            )
          }
        >
          <div className="help-body">{body}</div>
        </Dialog>
      )}
    </>
  );
}

/** The strip at the top of a tab: what the tab is for, and its help button at the right. */
export function TabHelp({ topic, children }: { topic: HelpTopicId; children: ReactNode }) {
  return (
    <div className="sub-tab-head">
      <span className="muted">{children}</span>
      <HelpButton topic={topic} />
    </div>
  );
}
