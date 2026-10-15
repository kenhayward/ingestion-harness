import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Me } from '../api/client.js';
import { useInstallAvailable, type InstallPrompt } from '../pwa/install.js';
import type { NotifySetting } from '../pwa/notify.js';
import type { Route } from '../router.js';
import { BrandMark } from '../ui/BrandMark.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { ThemeSwitch } from '../ui/ThemeSwitch.js';
import { Avatar } from './Avatar.js';
import { attentionCount, sectionOf } from './derive.js';

/** The API reference (served by the API, public: docs/design/api-docs.md). */
export const API_DOCS = '/api/docs/';

/** The nav's collapsed choice on ordinary pages, remembered per browser. */
const NAV_KEY = 'ih.navCollapsed';
function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(NAV_KEY) === '1';
  } catch {
    return false; // storage blocked: start expanded
  }
}
function saveCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(NAV_KEY, '1');
    else localStorage.removeItem(NAV_KEY);
  } catch {
    // storage blocked: the choice lasts for this visit only
  }
}

function NavLink({
  href,
  icon,
  label,
  current,
  compact,
  compactLabel = label,
  children,
}: {
  href: string;
  icon: IconName;
  label: string;
  current: boolean;
  compact: boolean;
  /** Accessible name and tooltip in compact mode (defaults to the label). */
  compactLabel?: string;
  children?: ReactNode;
}) {
  return (
    <a
      href={href}
      aria-current={current ? 'page' : undefined}
      aria-label={compact ? compactLabel : undefined}
      title={compact ? compactLabel : undefined}
    >
      <Icon name={icon} size={18} />
      <span className="nav-label">{label}</span>
      {children}
    </a>
  );
}

/**
 * The notifications bell (docs/design/pwa.md): toasts when your jobs finish while the app is in
 * the background. Refused in the browser, it says where to allow it again.
 */
function NotifyBell({ notify }: { notify: NotifySetting }) {
  if (notify.state === 'unsupported') return null;
  if (notify.state === 'blocked') {
    return (
      <button
        type="button"
        className="icon bordered"
        aria-label="Notifications are blocked"
        aria-disabled="true"
        title="Notifications are blocked for this site: allow them in the browser's site permissions (the padlock in the address bar, or the app's … menu → App info)"
      >
        <Icon name="bellOff" size={18} />
      </button>
    );
  }
  const label = 'Notify me when my jobs finish';
  return (
    <button
      type="button"
      className="icon bordered notify-toggle"
      aria-label={label}
      aria-pressed={notify.state === 'on'}
      title={notify.state === 'on' ? `${label}: on` : label}
      onClick={() => void notify.toggle()}
    >
      <Icon name="bell" size={18} />
    </button>
  );
}

/** What Install CT Studio is called everywhere (docs/design/pwa.md). */
const INSTALL_LABEL = 'Install CT Studio';

/**
 * The signed-in name, beside their picture (the linked GitHub account's, else initials), opens
 * the account menu: for admins Models, Linked data and Access (ADR 0010); Install CT Studio while
 * the browser offers it (admins); Profile for everyone with an email (not the admin from the log,
 * ADR 0013; docs/design/profile.md); Sign out. It closes on Escape (focus back on the name), a
 * click outside, or a choice.
 */
function AccountMenu({
  me,
  onInstall,
  onProfile,
  onSignOut,
}: {
  me: Me;
  /** Set while the browser offers install. */
  onInstall: (() => void) | null;
  onProfile: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const name = `${me.label} (${me.role}): account menu`;
  const admin = me.role === 'admin';

  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div
      className="user-chip account-menu"
      ref={box}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="account-trigger"
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Avatar name={me.label} url={me.avatarUrl} />
        <span className="who" aria-hidden="true">
          <span>{me.label}</span>
          <small>{me.role}</small>
        </span>
        <Icon name="chevronDown" size={16} />
      </button>
      {open && (
        <div role="menu" aria-label={name} className="menu-popover">
          {admin && (
            <>
              <a role="menuitem" href="#/models" onClick={() => setOpen(false)}>
                <Icon name="chip" />
                Models
              </a>
              <a role="menuitem" href="#/linked-data" onClick={() => setOpen(false)}>
                <Icon name="link" />
                Linked data
              </a>
              <a role="menuitem" href="#/access" onClick={() => setOpen(false)}>
                <Icon name="key" />
                Access
              </a>
            </>
          )}
          {me.email !== null && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onProfile();
              }}
            >
              <Icon name="user" />
              Profile
            </button>
          )}
          {admin && onInstall && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onInstall();
              }}
            >
              <Icon name="install" />
              {INSTALL_LABEL}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            <Icon name="signOut" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** Signed-in frame (UI handoff §0): top bar + left nav around the current page. */
export function AppShell({
  me,
  route,
  jobs,
  query,
  onQuery,
  install,
  notify,
  onUpload,
  onProfile,
  onSignOut,
  children,
}: {
  me: Me;
  route: Route;
  jobs: readonly JobSummary[];
  query: string;
  onQuery: (query: string) => void;
  /** The browser's offer to install the app: Install CT Studio shows while there is one. */
  install: InstallPrompt;
  /** Toasts for your jobs: the bell's state and toggle. */
  notify: NotifySetting;
  onUpload: () => void;
  /** The account menu's Profile: opens the Profile dialog. */
  onProfile: () => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const search = useRef<HTMLInputElement>(null);
  const section = sectionOf(route);
  const attention = attentionCount(jobs);
  const onInstall = useInstallAvailable(install) ? () => void install.install() : null;
  // Project pages need the width: the nav starts collapsed there, and expanding it lasts for the
  // visit. Elsewhere the person's own choice holds, remembered per browser.
  const onProject = route.name === 'project';
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [projectExpanded, setProjectExpanded] = useState(false);
  if (!onProject && projectExpanded) setProjectExpanded(false);
  const compact = onProject ? !projectExpanded : collapsed;
  const toggleNav = () => {
    if (onProject) setProjectExpanded(compact);
    else {
      saveCollapsed(!collapsed);
      setCollapsed(!collapsed);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app-shell">
      <header className="top-bar">
        <a
          className="brand"
          href="#/"
          aria-label="CT Studio — Content Transformation Studio, home"
          title="Content Transformation Studio"
        >
          <BrandMark size={30} />
          CT Studio
        </a>
        <label className="search">
          <Icon name="search" />
          <input
            ref={search}
            type="search"
            aria-label="Search jobs, results and document types"
            placeholder="Search jobs, results, document types…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onQuery('');
            }}
          />
          <kbd aria-hidden="true">Ctrl K</kbd>
        </label>
        <div className="top-actions">
          {onInstall && (
            <button
              type="button"
              className="icon bordered"
              aria-label={INSTALL_LABEL}
              title={INSTALL_LABEL}
              onClick={onInstall}
            >
              <Icon name="install" size={18} />
            </button>
          )}
          <NotifyBell notify={notify} />
          <ThemeSwitch />
          <button type="button" className="primary" onClick={onUpload}>
            <Icon name="upload" />
            Upload document
          </button>
          <AccountMenu me={me} onInstall={onInstall} onProfile={onProfile} onSignOut={onSignOut} />
        </div>
      </header>
      <div className="app-body">
        <nav id="main-nav" className={compact ? 'side-nav compact' : 'side-nav'} aria-label="Main">
          <button
            type="button"
            className="nav-toggle"
            aria-controls="main-nav"
            aria-expanded={!compact}
            aria-label={compact ? 'Expand menu' : 'Collapse menu'}
            title={compact ? 'Expand menu' : 'Collapse menu'}
            onClick={toggleNav}
          >
            <Icon name={compact ? 'chevronRight' : 'chevronLeft'} size={16} />
          </button>
          <NavLink
            href="#/"
            icon="home"
            label="Home"
            current={section === 'home'}
            compact={compact}
          />
          <NavLink
            href="#/jobs"
            icon="jobs"
            label="Jobs"
            compactLabel={attention > 0 ? `Jobs, ${attention} need attention` : 'Jobs'}
            current={section === 'jobs'}
            compact={compact}
          >
            {attention > 0 && (
              <span className="nav-badge">
                <span aria-hidden="true">{attention}</span>
                <span className="visually-hidden">{attention} need attention</span>
              </span>
            )}
          </NavLink>
          <NavLink
            href="#/results"
            icon="results"
            label="Results"
            current={section === 'results'}
            compact={compact}
          />
          <NavLink
            href="#/templates"
            icon="types"
            label="Document types"
            current={section === 'templates'}
            compact={compact}
          />
          <NavLink
            href="#/ontologies"
            icon="graph"
            label="Ontologies"
            current={section === 'ontologies'}
            compact={compact}
          />
          <NavLink
            href="#/workbench"
            icon="workbench"
            label="Workbench"
            current={section === 'workbench'}
            compact={compact}
          />
          {me.role === 'admin' && (
            <>
              <span className="nav-heading">Admin</span>
              <NavLink
                href="#/models"
                icon="chip"
                label="Models"
                current={section === 'models'}
                compact={compact}
              />
              <NavLink
                href="#/linked-data"
                icon="link"
                label="Linked data"
                current={section === 'linked-data'}
                compact={compact}
              />
              <NavLink
                href="#/access"
                icon="key"
                label="Access"
                current={section === 'access'}
                compact={compact}
              />
            </>
          )}
          <a
            className="nav-foot"
            href={API_DOCS}
            target="_blank"
            rel="noopener"
            aria-label={compact ? 'API docs (opens in a new tab)' : undefined}
            title={compact ? 'API docs' : undefined}
          >
            <Icon name="file" size={18} />
            <span className="nav-label">API docs</span>
            <Icon name="open" size={14} />
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        </nav>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
