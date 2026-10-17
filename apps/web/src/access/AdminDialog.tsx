import { useId, useRef, useState, type KeyboardEvent } from 'react';
import type { MaintenanceView } from '@ih/shared';
import type { Api, Me } from '../api/client.js';
import { LinkedDataPage } from '../linked-data/LinkedDataPage.js';
import { ModelsPage } from '../models/ModelsPage.js';
import { Avatar } from '../shell/Avatar.js';
import { useModalFocus } from '../ui/Dialog.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { AccessPage } from './AccessPage.js';
import { IntegrationPage } from './IntegrationPage.js';
import { MaintenancePage } from './MaintenancePage.js';
import { PublishedOutputsPage } from './PublishedOutputsPage.js';
import type { HelpTopicId } from '../help/topics.js';
import { HelpButton } from '../ui/Help.js';

export type AdminTab =
  'models' | 'linked-data' | 'published-outputs' | 'users' | 'integration' | 'maintenance';

const TABS: { id: AdminTab; label: string; icon: IconName }[] = [
  { id: 'models', label: 'Models', icon: 'chip' },
  { id: 'linked-data', label: 'Linked data', icon: 'link' },
  { id: 'published-outputs', label: 'Published outputs', icon: 'upload' },
  { id: 'users', label: 'Users', icon: 'users' },
  { id: 'integration', label: 'Integration', icon: 'plug' },
  { id: 'maintenance', label: 'Maintenance', icon: 'warning' },
];

/** Each tab's help, last in the header after the tab's main button (Integration's sections carry
 * their own). */
const TAB_HELP: Partial<Record<AdminTab, HelpTopicId>> = {
  models: 'adminModels',
  'linked-data': 'adminLinkedData',
  'published-outputs': 'published-outputs',
  users: 'adminUsers',
};

const TAB_KEY = 'ih.adminTab';

function loadTab(): AdminTab {
  try {
    // The Users tab was called Access: a browser that remembers it opens on Users.
    const stored = localStorage.getItem(TAB_KEY)?.replace(/^access$/, 'users');
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
 * The account menu's Administration (admins only): Models, Linked data, Users, Integration and
 * Maintenance as tabs of one
 * dialog laid out like Profile, each tab's main button in the header. It has no address. Only
 * Close closes it: not a click outside, not Escape, so a half-typed key or URL is never lost.
 */
export function AdminDialog({
  api,
  me,
  onClose,
  onMaintenanceChanged,
}: {
  api: Api;
  me: Me;
  onClose: () => void;
  /** Maintenance mode was saved: the app's strip follows. */
  onMaintenanceChanged?: (view: MaintenanceView) => void;
}) {
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
            {TAB_HELP[tab] && <HelpButton key={tab} topic={TAB_HELP[tab]} />}
          </header>
          <div
            className="profile-body admin-body"
            role="tabpanel"
            id={`${ids}-panel-${tab}`}
            aria-labelledby={`${ids}-tab-${tab}`}
          >
            {tab === 'models' && <ModelsPage api={api} me={me} actions={actions} />}
            {tab === 'linked-data' && <LinkedDataPage api={api} me={me} />}
            {tab === 'published-outputs' && (
              <PublishedOutputsPage api={api} me={me} actions={actions} />
            )}
            {tab === 'users' && <AccessPage api={api} me={me} actions={actions} />}
            {tab === 'integration' && <IntegrationPage api={api} me={me} />}
            {tab === 'maintenance' && (
              <MaintenancePage api={api} me={me} onChanged={onMaintenanceChanged} />
            )}
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
