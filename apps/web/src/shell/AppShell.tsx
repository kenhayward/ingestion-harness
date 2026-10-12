import { useEffect, useRef, type ReactNode } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Me } from '../api/client.js';
import type { Route } from '../router.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { ThemeSwitch } from '../ui/ThemeSwitch.js';
import { attentionCount, initials, sectionOf } from './derive.js';

function NavLink({
  href,
  icon,
  label,
  current,
  children,
}: {
  href: string;
  icon: IconName;
  label: string;
  current: boolean;
  children?: ReactNode;
}) {
  return (
    <a href={href} aria-current={current ? 'page' : undefined}>
      <Icon name={icon} size={18} />
      <span className="nav-label">{label}</span>
      {children}
    </a>
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
        <a className="brand" href="#/">
          <span className="brand-mark">
            <Icon name="brand" size={18} />
          </span>
          Ingestion Harness
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
            Upload PDF
          </button>
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
        </div>
      </header>
      <div className="app-body">
        <nav className="side-nav" aria-label="Main">
          <NavLink href="#/" icon="jobs" label="Jobs" current={section === 'jobs'}>
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
          />
          <NavLink
            href="#/templates"
            icon="types"
            label="Document types"
            current={section === 'templates'}
          />
          {me.role === 'admin' && (
            <>
              <span className="nav-heading">Admin</span>
              <NavLink href="#/access" icon="key" label="Access" current={section === 'access'} />
            </>
          )}
        </nav>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
