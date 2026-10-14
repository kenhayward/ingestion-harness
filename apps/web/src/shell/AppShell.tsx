import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Me } from '../api/client.js';
import type { Route } from '../router.js';
import { BrandMark } from '../ui/BrandMark.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { ThemeSwitch } from '../ui/ThemeSwitch.js';
import { attentionCount, initials, sectionOf } from './derive.js';

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
 * An admin's name opens the account menu (Models, Access, Sign out; ADR 0010). It closes on
 * Escape (focus back on the name), a click outside, or a choice.
 */
function AccountMenu({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const name = `${me.label} (${me.role}): account menu`;

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
        <span className="avatar" aria-hidden="true">
          {initials(me.label)}
        </span>
        <span className="who" aria-hidden="true">
          <span>{me.label}</span>
          <small>{me.role}</small>
        </span>
        <Icon name="chevronDown" size={16} />
      </button>
      {open && (
        <div role="menu" aria-label={name} className="menu-popover">
          <a role="menuitem" href="#/models" onClick={() => setOpen(false)}>
            <Icon name="chip" />
            Models
          </a>
          <a role="menuitem" href="#/access" onClick={() => setOpen(false)}>
            <Icon name="key" />
            Access
          </a>
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
  onUpload,
  onSignOut,
  children,
}: {
  me: Me;
  route: Route;
  jobs: readonly JobSummary[];
  query: string;
  onQuery: (query: string) => void;
  onUpload: () => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const search = useRef<HTMLInputElement>(null);
  const section = sectionOf(route);
  const attention = attentionCount(jobs);
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
          <ThemeSwitch />
          <button type="button" className="primary" onClick={onUpload}>
            <Icon name="upload" />
            Upload document
          </button>
          {me.role === 'admin' ? (
            <AccountMenu me={me} onSignOut={onSignOut} />
          ) : (
            <div
              className="user-chip"
              role="group"
              aria-label={`Signed in as ${me.label} (${me.role})`}
            >
              <span className="avatar" aria-hidden="true">
                {initials(me.label)}
              </span>
              <span className="who" aria-hidden="true">
                <span>{me.label}</span>
                <small>{me.role}</small>
              </span>
              <button
                type="button"
                className="icon"
                aria-label="Sign out"
                title="Sign out"
                onClick={onSignOut}
              >
                <Icon name="signOut" size={18} />
              </button>
            </div>
          )}
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
