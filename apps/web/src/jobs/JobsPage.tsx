import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Api, JobPageParams } from '../api/client.js';
import { statusGroup } from '../shell/derive.js';
import { FilterChips } from '../ui/FilterChips.js';
import { JobCleanup } from './JobCleanup.js';
import { JobDetailPanel } from './JobDetailPanel.js';
import { JobList } from './JobList.js';
import { JobsPager } from './JobsPager.js';
import { usePageSize } from './usePageSize.js';
import { useJobPage } from './useJobPage.js';
import { primaryAction, type Chip } from './derive.js';
import { useModelChoices } from '../ui/ModelPicker.js';
import { HelpButton } from '../ui/Help.js';

/** Rows a page shows until the list's height is measured (and where it cannot be: tests). */
export const FALLBACK_PAGE_SIZE = 25;
/** The search waits this long after typing before asking the server. */
export const SEARCH_DELAY_MS = 250;

const jobsText = (n: number) => `${n} ${n === 1 ? 'job' : 'jobs'}`;

/** The My jobs toggle, remembered per browser. */
const MINE_KEY = 'ih.jobsMine';
function loadMine(): boolean {
  try {
    return localStorage.getItem(MINE_KEY) === '1';
  } catch {
    return false; // private mode or blocked storage
  }
}
function saveMine(mine: boolean) {
  try {
    if (mine) localStorage.setItem(MINE_KEY, '1');
    else localStorage.removeItem(MINE_KEY);
  } catch {
    // Private mode or blocked storage: the choice lasts for this visit only.
  }
}

/** Where the shown page starts: the newest jobs, or a job's place in the list. */
type Anchor = { kind: 'top' } | { kind: 'before' | 'after' | 'from'; id: string };
const TOP: Anchor = { kind: 'top' };

/**
 * Jobs (UI handoff §1; uploading is on Home): status chips, the My jobs toggle, job list + detail
 * panel, clean-up. The list is paged on the server (`GET /api/jobs/page`, `useJobPage`) from a
 * job's place in it, so every job can be reached; the chips' counts, the search and My jobs
 * are answered there too.
 *
 * The page fits the window (side by side): the list shows as many one-line rows as its box
 * holds (`usePageSize`), paged from the pager above it, so the page never scrolls. ↑/↓ move the
 * selection (across pages), Page Up/Down change page, Enter opens the selected job's review.
 */
export function JobsPage({
  api,
  refresh: refreshAll,
  query,
  pollMs,
  jobId,
}: {
  api: Api;
  /** A shared link's job (#/jobs/<id>): opened in the panel, on its page. */
  jobId?: string;
  /** The app's own job lists (the badges): refreshed after an action here. */
  refresh: () => Promise<void>;
  /** Top-bar search. */
  query: string;
  /** Poll interval, for the live indicator; <= 0 = not polling. */
  pollMs: number;
}) {
  const [chip, setChip] = useState<Chip>('all');
  // A shared link opens on every job, not only the reader's own (not saved).
  const [mine, setMine] = useState(() => (jobId ? false : loadMine()));
  const [anchor, setAnchor] = useState<Anchor>(jobId ? { kind: 'from', id: jobId } : TOP);
  const [search, setSearch] = useState(query);
  const lastQuery = useRef(query);
  useEffect(() => {
    if (lastQuery.current === query) return;
    lastQuery.current = query;
    const timer = setTimeout(() => {
      setSearch(query);
      setAnchor(TOP); // a new view starts at the newest
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const pickChip = (next: Chip) => {
    setChip(next);
    setAnchor(TOP);
  };
  const toggleMine = () => {
    saveMine(!mine);
    setMine(!mine);
    setAnchor(TOP);
  };
  const { box: listBox, size: pageSize } = usePageSize<HTMLDivElement>(FALLBACK_PAGE_SIZE);
  const params: JobPageParams = {
    size: pageSize,
    ...(chip !== 'all' ? { group: chip } : {}),
    ...(mine ? { mine: true } : {}),
    ...(search.trim() ? { q: search.trim() } : {}),
    ...(anchor.kind !== 'top' ? { [anchor.kind]: anchor.id } : {}),
  };
  const { page, current, error, refresh: refreshPage } = useJobPage(api, params, pollMs);
  const jobs = useMemo(() => page?.jobs ?? [], [page]);
  // Actions change this page and the app's own lists (the badges).
  const refresh = async () => {
    await Promise.all([refreshAll(), refreshPage()]);
  };

  const [selectedId, setSelectedId] = useState<string | null>(jobId ?? null);
  /** The selected job as last seen, so paging away leaves it in the panel. */
  const [selectedJob, setSelectedJob] = useState<JobSummary | null>(null);
  /** The page (its params) the selected job was last seen on: gone from it = deleted. */
  const seenOn = useRef<string | null>(null);
  /** The view (chip, My jobs, search) it was seen in: another view never keeps it. */
  const seenIn = useRef<string | null>(null);
  // A new link while the page is open selects its job, on its page.
  const lastLink = useRef(jobId);
  useEffect(() => {
    if (!jobId || lastLink.current === jobId) return;
    lastLink.current = jobId;
    setSelectedId(jobId);
    setAnchor({ kind: 'from', id: jobId });
  }, [jobId]);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  /** After a keyboard move to another page: which of its jobs to select once it loads. */
  const [pick, setPick] = useState<'first' | 'last' | null>(null);
  /** A row to focus once it has rendered (keyboard moves). */
  const [focusId, setFocusId] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);
  const models = useModelChoices(api);
  const [specTitles, setSpecTitles] = useState<ReadonlyMap<string, string>>(new Map());
  /** Each type's model, from its newest version (what Retry and Re-process run on). */
  const [typeModels, setTypeModels] = useState<ReadonlyMap<string, { model?: string }>>(new Map());

  useEffect(() => {
    // Retired types too: old jobs and results keep their names.
    api.listSpecs({ retired: 'include' }).then(
      (specs) => {
        setSpecTitles(new Map(specs.map((s) => [s.id, s.title])));
        // Listed oldest version first: the newest one wins.
        setTypeModels(new Map(specs.map((s) => [s.id, s.model ? { model: s.model } : {}])));
      },
      () => {}, // titles are cosmetic: ids are shown instead
    );
  }, [api]);

  const pageKey = JSON.stringify(params);
  const viewKey = JSON.stringify([chip, mine, search.trim()]);
  const onPage = jobs.find((j) => j.id === selectedId);
  // Paging leaves the selected job in the panel; gone from the page it was last seen on
  // (deleted), or another view, falls back.
  const gone = !onPage && current && seenOn.current === pageKey;
  const kept =
    !gone && seenIn.current === viewKey && selectedJob?.id === selectedId ? selectedJob : null;
  // The selection falls back (never stored) when its job is deleted or filtered out.
  const selected =
    onPage ?? kept ?? jobs.find((j) => statusGroup(j.status) === 'attention') ?? jobs[0] ?? null;
  useEffect(() => {
    if (onPage && current) {
      seenOn.current = pageKey;
      seenIn.current = viewKey;
      setSelectedJob(onPage);
    }
  }, [onPage, current, pageKey, viewKey]);
  // Pin what the panel shows: a later poll (a newer job needing attention) must not swap the
  // panel, and with it any confirm or model picker open there.
  // Only once the page asked for has loaded: a link or keyboard move waits for its page.
  const shownId = selected?.id ?? null;
  useEffect(() => {
    if (current && shownId !== null && shownId !== selectedId) setSelectedId(shownId);
  }, [current, shownId, selectedId]);
  // A keyboard move to another page selects its first or last job once it has loaded.
  useEffect(() => {
    if (!pick || !current || jobs.length === 0) return;
    const target = pick === 'first' ? jobs[0]! : jobs[jobs.length - 1]!;
    setPick(null);
    setSelectedId(target.id);
    setFocusId(target.id);
  }, [pick, current, jobs]);
  useEffect(() => {
    if (!focusId) return;
    const row = section.current?.querySelector<HTMLElement>(
      `tr[data-job-id="${CSS.escape(focusId)}"] .doc-button`,
    );
    if (!row) return;
    row.focus();
    setFocusId(null);
  }, [focusId, jobs]);

  const older = () => {
    const last = jobs[jobs.length - 1];
    if (page?.hasOlder && last) setAnchor({ kind: 'before', id: last.id });
  };
  const newer = () => {
    const first = jobs[0];
    if (page?.hasNewer && first) setAnchor({ kind: 'after', id: first.id });
  };
  const onListKey = (e: KeyboardEvent<HTMLElement>) => {
    const el = e.target as HTMLElement;
    const id = el.closest<HTMLElement>('.job-list tr')?.dataset.jobId;
    // Only from the rows themselves: never inside a menu, a confirmation or a dialog.
    if (!id || el.closest('.menu, .row-popover, [role="dialog"]')) return;
    const at = jobs.findIndex((j) => j.id === id);
    if (at < 0) return;
    const select = (target: JobSummary) => {
      setSelectedId(target.id);
      setFocusId(target.id);
    };
    const turn = (go: () => void, which: 'first' | 'last') => {
      go();
      setPick(which);
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (at < jobs.length - 1) select(jobs[at + 1]!);
      else if (page?.hasOlder) turn(older, 'first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (at > 0) select(jobs[at - 1]!);
      else if (page?.hasNewer) turn(newer, 'last');
    } else if (e.key === 'PageDown' && page?.hasOlder) {
      e.preventDefault();
      turn(older, 'first');
    } else if (e.key === 'PageUp' && page?.hasNewer) {
      e.preventDefault();
      turn(newer, 'first');
    } else if (e.key === 'Enter' && el.classList.contains('doc-button') && id === selected?.id) {
      const action = primaryAction(selected);
      if (action === 'review' || action === 'view') {
        e.preventDefault();
        window.location.hash = `#/review/${id}`;
      }
    }
  };
  const now = Date.now();
  const counts = page?.counts ?? { all: 0, attention: 0, active: 0, done: 0 };
  const linkedMissing =
    jobId !== undefined &&
    current &&
    anchor.kind === 'from' &&
    anchor.id === jobId &&
    !jobs.some((j) => j.id === jobId);
  const searching = search.trim();

  return (
    <div className="jobs-page">
      <div className="page-header">
        <h1>Jobs</h1>
        <div className="page-header-actions">
          {pollMs > 0 && (
            <span className={error ? 'live live-warn' : 'live'}>
              <span className="live-dot" aria-hidden="true" />
              {error ? 'Reconnecting…' : `Live · refreshes every ${pollMs / 1000} s`}
            </span>
          )}
          <HelpButton topic="jobs" />
        </div>
      </div>
      {linkedMissing && (
        <p role="status" aria-label="Linked job" className="kept-note">
          The linked job is not in this list: it may have been deleted.
        </p>
      )}
      {error && <p role="alert">Failed to load jobs: {error}</p>}
      <div className="jobs-layout">
        <section className="jobs-main" aria-label="Job list" ref={section} onKeyDown={onListKey}>
          <div className="job-list-box">
            <div className="jobs-filters">
              <FilterChips
                label="Filter jobs by status"
                value={chip}
                onChange={pickChip}
                chips={[
                  { value: 'all', label: 'All', count: counts.all },
                  {
                    value: 'attention',
                    label: 'Needs attention',
                    count: counts.attention,
                    tone: 'warn',
                  },
                  { value: 'active', label: 'In progress', count: counts.active },
                  { value: 'done', label: 'Finished', count: counts.done },
                ]}
              />
              <button
                type="button"
                className="chip mine-toggle"
                aria-pressed={mine}
                title="Only the jobs queued by your token"
                onClick={toggleMine}
              >
                My jobs
              </button>
              <JobsPager
                from={page?.start ?? 0}
                to={(page?.start ?? 0) + jobs.length}
                total={page?.total ?? 0}
                size={pageSize}
                hasNewer={page?.hasNewer ?? false}
                hasOlder={page?.hasOlder ?? false}
                onNewer={newer}
                onOlder={older}
              />
            </div>
            <div className="job-list-rows" ref={listBox}>
              {mine && page && counts.all === 0 && !searching && !error ? (
                <p className="job-list-empty">You have not queued any jobs yet.</p>
              ) : page && page.total === 0 && (counts.all > 0 || searching) ? (
                <p className="job-list-empty">
                  {searching ? `No jobs match “${searching}”.` : 'No jobs in this view.'}
                </p>
              ) : (
                <JobList
                  api={api}
                  jobs={jobs}
                  selectedId={selected?.id ?? null}
                  onSelect={setSelectedId}
                  onChanged={refresh}
                  models={models}
                  specTitles={specTitles}
                  typeModels={typeModels}
                  now={now}
                />
              )}
            </div>
            <div className="list-footer">
              <span className="muted keys-hint">
                <kbd>↑</kbd> <kbd>↓</kbd> select · <kbd>PgUp</kbd> <kbd>PgDn</kbd> page ·{' '}
                <kbd>Enter</kbd> open
              </span>
              <span className="muted">
                Showing {page?.total ?? 0} of {jobsText(counts.all)}
              </span>
              <button
                type="button"
                className="link"
                aria-expanded={cleanupOpen}
                onClick={() => setCleanupOpen((o) => !o)}
              >
                Clean up finished jobs…
              </button>
            </div>
          </div>
          {cleanupOpen && <JobCleanup api={api} onChanged={refresh} />}
        </section>
        {selected && (
          <JobDetailPanel
            key={selected.id}
            api={api}
            job={selected}
            onChanged={refresh}
            models={models}
            specTitles={specTitles}
            typeModels={typeModels}
            now={now}
          />
        )}
      </div>
    </div>
  );
}
