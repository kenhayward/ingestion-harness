import { useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Api, Me } from '../api/client.js';
import { LinkedDataPage } from '../linked-data/LinkedDataPage.js';
import { ModelsPage } from '../models/ModelsPage.js';
import { Avatar } from '../shell/Avatar.js';
import { useModalFocus } from '../ui/Dialog.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { AccessPage } from './AccessPage.js';

export type AdminTab = 'models' | 'linked-data' | 'access';

const TABS: { id: AdminTab; label: string; icon: IconName }[] = [
  { id: 'models', label: 'Models', icon: 'chip' },
  { id: 'linked-data', label: 'Linked data', icon: 'link' },
  { id: 'access', label: 'Access', icon: 'key' },
];

const TAB_KEY = 'ih.adminTab';

function loadTab(): AdminTab {
  try {
    const stored = localStorage.getItem(TAB_KEY);
    return TABS.find((t) => t.id === stored)?.id ?? 'models';
  } catch {
    return 'models';
  }
}

function saveTab(tab: AdminTab) {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Storage blocked: the dialog opens on Models next time.
  }
}

/**
 * The account menu's Administration (admins only): Models, Linked data and Access as tabs of one
 * dialog laid out like Profile, each tab's main button in the header. It has no address. Only
 * Close closes it: not a click outside, not Escape, so a half-typed key or URL is never lost.
 */
export function AdminDialog({ api, me, onClose }: { api: Api; me: Me; onClose: () => void }) {
  const [tab, setTab] = useState<AdminTab>(loadTab);
  /** The header's slot for the open tab's main button (Add endpoint, Add user). */
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const titleId = useId();
  const ids = useId();
  const box = useRef<HTMLDivElement>(null);
  const trapTab = useModalFocus(box);
  const tabRefs = useRef(new Map<AdminTab, HTMLButtonElement>());
  const current = TABS.find((t) => t.id === tab)!;

  const choose = (next: AdminTab) => {
    setTab(next);
    saveTab(next);
  };

  const onTabKey = (e: KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = TABS[(TABS.indexOf(current) + step + TABS.length) % TABS.length]!;
    choose(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  return (
    <div className="dialog-backdrop">
      <div
        ref={box}
        className="dialog profile-dialog admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trapTab}
      >
        <aside className="profile-side">
          <div className="profile-id">
            <Avatar name={me.label} url={me.avatarUrl} size="large" />
            <span className="profile-who">{me.label}</span>
          </div>
          <div
            role="tablist"
            aria-label="Administration sections"
            aria-orientation="vertical"
            className="profile-tabs"
            onKeyDown={onTabKey}
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(t.id, el);
                }}
                type="button"
                role="tab"
                id={`${ids}-tab-${t.id}`}
                aria-selected={t.id === tab}
                aria-controls={`${ids}-panel-${t.id}`}
                tabIndex={t.id === tab ? 0 : -1}
                onClick={() => choose(t.id)}
              >
                <Icon name={t.icon} size={18} />
                {t.label}
              </button>
            ))}
          </div>
        </aside>
        <section className="profile-main">
          <header className="profile-header admin-header">
            <h2 id={titleId}>Administration</h2>
            <span className="muted">/ {current.label}</span>
            <span className="admin-header-actions" ref={setActions} />
          </header>
          <div
            className="profile-body admin-body"
            role="tabpanel"
            id={`${ids}-panel-${tab}`}
            aria-labelledby={`${ids}-tab-${tab}`}
          >
            {tab === 'models' && <ModelsPage api={api} me={me} actions={actions} />}
            {tab === 'linked-data' && <LinkedDataPage api={api} me={me} />}
            {tab === 'access' && <AccessPage api={api} me={me} actions={actions} />}
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
