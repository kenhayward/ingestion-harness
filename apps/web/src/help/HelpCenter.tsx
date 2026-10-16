import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { BrandMark } from '../ui/BrandMark.js';
import { useModalFocus } from '../ui/Dialog.js';
import { HELP_INDEX, helpEntries, type HelpEntry } from './index.js';
import { HELP_TOPICS, type HelpTopicId } from './topics.js';

/**
 * The account menu's Help: every help topic in one place, laid out like Profile. The app mark and
 * the topic menu (HELP_INDEX: the screens, each with its parts) on the left; the open topic on the
 * right. Escape, a click outside or Close closes it (there is nothing to lose).
 */
export function HelpCenter({
  topic: initial = 'introduction',
  onClose,
}: {
  topic?: HelpTopicId;
  onClose: () => void;
}) {
  const [topic, setTopic] = useState<HelpTopicId>(initial);
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const trapTab = useModalFocus(box);
  const { title } = HELP_TOPICS[topic];
  const entries = helpEntries();

  // A new topic starts at its top.
  useEffect(() => {
    body.current?.scrollTo?.({ top: 0 });
  }, [topic]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    // Up and Down move through the menu, as in Profile's ledger.
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    const target = e.target as HTMLElement;
    if (step && target.closest('.help-center-menu')) {
      e.preventDefault();
      const i = entries.findIndex((x) => x.topic === topic);
      const next = entries[(i + step + entries.length) % entries.length]!;
      setTopic(next.topic);
      box.current?.querySelector<HTMLButtonElement>(`[data-topic="${next.topic}"]`)?.focus();
      return;
    }
    trapTab(e);
  };

  const item = (e: HelpEntry) => (
    <li key={e.topic}>
      <button
        type="button"
        data-topic={e.topic}
        aria-current={e.topic === topic ? 'page' : undefined}
        onClick={() => setTopic(e.topic)}
      >
        {e.label}
      </button>
      {e.children && <ul>{e.children.map(item)}</ul>}
    </li>
  );

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        className="dialog profile-dialog help-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <aside className="profile-side help-center-side">
          <div className="profile-id">
            <BrandMark size={64} />
            <span className="profile-who">
              <span>CT Studio</span>
              <small className="muted">Help</small>
            </span>
          </div>
          <nav aria-label="Help topics" className="help-center-menu">
            <ul>{HELP_INDEX.map(item)}</ul>
          </nav>
        </aside>
        <section className="profile-main">
          <header className="profile-header">
            <h2 id={titleId}>Help</h2>
            <span className="muted">/ {title}</span>
          </header>
          <div ref={body} className="profile-body help-body help-center-body">
            {HELP_TOPICS[topic].body}
          </div>
          <footer className="profile-footer">
            <button type="button" onClick={onClose}>
              Close
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}
