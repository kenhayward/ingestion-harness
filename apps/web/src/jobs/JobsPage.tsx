import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { matchesQuery, statusGroup } from '../shell/derive.js';
import { useJobs } from '../shell/useJobs.js';
import { FilterChips } from '../ui/FilterChips.js';
import { JobCleanup } from './JobCleanup.js';
import { JobDetailPanel } from './JobDetailPanel.js';
import { JobList } from './JobList.js';
import { JobsPager } from './JobsPager.js';
import { usePageSize } from './usePageSize.js';
import { chipCounts, inChip, modelLabel, pageRange, primaryAction, type Chip } from './derive.js';
import { useModelChoices } from '../ui/ModelPicker.js';
import { HelpButton } from '../ui/Help.js';

/** Rows a page shows until the list's height is measured (and where it cannot be: tests). */
export const FALLBACK_PAGE_SIZE = 25;

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

/**
 * Jobs (UI handoff §1; uploading is on Home): status chips, the My jobs toggle, job list + detail panel,
 * clean-up. My jobs asks the server for the signed-in token's jobs (so the list limit applies
 * to them, not to everyone's) and polls them itself; the status chips apply on top.
 *
 * The page fits the window (side by side): the list shows as many one-line rows as its box
 * holds (`usePageSize`), paged from the pager above it, so the page never scrolls. ↑/↓ move the
 * selection (across pages), Page Up/Down change page, Enter opens the selected job's review.
 */
export function JobsPage({
  api,
  jobs: allJobs,
  error: allError,
  refresh: refreshAll,
  query,
  pollMs,
  jobId,
}: {
  api: Api;
  /** A shared link's job (#/jobs/<id>): opened in the panel, from the full list. */
  jobId?: string;
  jobs: JobSummary[];
  /** The last poll failed with this message (the list shows the previous result). */
  error: string | null;
  refresh: () => Promise<void>;
  /** Top-bar search. */
  query: string;
  /** Poll interval, for the live indicator; <= 0 = not polling. */
  pollMs: number;
}) {
  const [chip, setChip] = useState<Chip>('all');
  // A shared link opens on every job, not only the reader's own (not saved).
  const [mine, setMine] = useState(() => (jobId ? false : loadMine()));
  const mineJobs = useJobs(api, pollMs, { mine: true, enabled: mine });
  const jobs = mine ? mineJobs.jobs : allJobs;
  const error = mine ? mineJobs.error : allError;
  // Actions change both lists: the shared one also drives the nav badge.
  const refresh = async () => {
    await Promise.all([refreshAll(), mine ? mineJobs.refresh() : null]);
  };
  const toggleMine = () => {
    saveMine(!mine);
    setMine(!mine);
  };
  const [selectedId, setSelectedId] = useState<string | null>(jobId ?? null);
  // A new link while the page is open selects its job.
  useEffect(() => {
    if (jobId) {
      setSelectedId(jobId);
      setJumpTo(jobId);
    }
  }, [jobId]);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const { box: listBox, size: pageSize } = usePageSize<HTMLDivElement>(FALLBACK_PAGE_SIZE);
  const [pageIndex, setPageIndex] = useState(0);
  /** A row to focus once its page has rendered (keyboard moves). */
  const [focusId, setFocusId] = useState<string | null>(null);
  /** A linked job whose page to open once it is in the list. */
  const [jumpTo, setJumpTo] = useState<string | null>(jobId ?? null);
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

  const counts = chipCounts(jobs);
  const visible = jobs.filter(
    (j) =>
      inChip(j, chip) &&
      matchesQuery(
        query,
        j.filename,
        j.specId,
        j.modelOverride,
        j.status,
        ...j.modelsUsed,
        modelLabel(j, models),
      ),
  );
  // The selection falls back (never stored) when its job is deleted or filtered out.
  const selected =
    visible.find((j) => j.id === selectedId) ??
    visible.find((j) => statusGroup(j.status) === 'attention') ??
    visible[0] ??
    null;
  // Pin what the panel shows: a later poll (a newer job needing attention) must not swap the
  // panel, and with it any confirm or model picker open there.
  const shownId = selected?.id ?? null;
  useEffect(() => {
    if (shownId !== null && shownId !== selectedId) setSelectedId(shownId);
  }, [shownId, selectedId]);
  // A new view starts on its first page.
  useEffect(() => setPageIndex(0), [chip, mine, query]);
  // A resize keeps the first job shown in view.
  const lastSize = useRef(pageSize);
  useEffect(() => {
    if (lastSize.current === pageSize) return;
    setPageIndex((p) => Math.floor((p * lastSize.current) / pageSize));
    lastSize.current = pageSize;
  }, [pageSize]);
  // A linked job opens on its page, once the list holds it.
  const jumpAt = jumpTo === null ? -1 : visible.findIndex((j) => j.id === jumpTo);
  useEffect(() => {
    if (jumpAt < 0) return;
    setPageIndex(Math.floor(jumpAt / pageSize));
    setJumpTo(null);
  }, [jumpAt, pageSize]);
  const range = pageRange(visible.length, pageSize, pageIndex);
  const pageJobs = visible.slice(range.from, range.to);
  useEffect(() => {
    if (!focusId) return;
    section.current
      ?.querySelector<HTMLElement>(`tr[data-job-id="${CSS.escape(focusId)}"] .doc-button`)
      ?.focus();
    setFocusId(null);
  }, [focusId, range.page]);

  /** Select the job at `index` of the view, on its page, and focus its row. */
  const moveTo = (index: number) => {
    const target = visible[index];
    if (!target) return;
    setSelectedId(target.id);
    setPageIndex(Math.floor(index / pageSize));
    setFocusId(target.id);
  };
  const onListKey = (e: KeyboardEvent<HTMLElement>) => {
    const el = e.target as HTMLElement;
    const id = el.closest<HTMLElement>('.job-list tr')?.dataset.jobId;
    // Only from the rows themselves: never inside a menu, a confirmation or a dialog.
    if (!id || el.closest('.menu, .row-popover, [role="dialog"]')) return;
    const at = visible.findIndex((j) => j.id === id);
    if (at < 0) return;
    const go = (index: number) => {
      e.preventDefault();
      moveTo(index);
    };
    if (e.key === 'ArrowDown') go(Math.min(at + 1, visible.length - 1));
    else if (e.key === 'ArrowUp') go(Math.max(at - 1, 0));
    else if (e.key === 'PageDown' && range.page < range.pages - 1) go((range.page + 1) * pageSize);
    else if (e.key === 'PageUp' && range.page > 0) go((range.page - 1) * pageSize);
    else if (e.key === 'Enter' && el.classList.contains('doc-button') && id === selected?.id) {
      const action = primaryAction(selected);
      if (action === 'review' || action === 'view') {
        e.preventDefault();
        window.location.hash = `#/review/${id}`;
      }
    }
  };
  const now = Date.now();
  const linkedMissing = jobId !== undefined && jobs.length > 0 && !jobs.some((j) => j.id === jobId);

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
          The linked job is not in this list: it may have been deleted, or be older than the list
          shows.
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
                onChange={setChip}
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
                from={range.from}
                to={range.to}
                total={visible.length}
                page={range.page}
                pages={range.pages}
                onPage={setPageIndex}
              />
            </div>
            <div className="job-list-rows" ref={listBox}>
              {mine && mineJobs.loaded && jobs.length === 0 && !error ? (
                <p className="job-list-empty">You have not queued any jobs yet.</p>
              ) : jobs.length > 0 && visible.length === 0 ? (
                <p className="job-list-empty">
                  {query.trim() ? `No jobs match “${query.trim()}”.` : 'No jobs in this view.'}
                </p>
              ) : (
                <JobList
                  api={api}
                  jobs={pageJobs}
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
                Showing {visible.length} of {jobsText(jobs.length)}
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
