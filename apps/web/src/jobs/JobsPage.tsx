import { useEffect, useState } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { matchesQuery, statusGroup } from '../shell/derive.js';
import { useJobs } from '../shell/useJobs.js';
import { FilterChips } from '../ui/FilterChips.js';
import { JobCleanup } from './JobCleanup.js';
import { JobDetailPanel } from './JobDetailPanel.js';
import { JobList } from './JobList.js';
import { chipCounts, inChip, modelLabel, type Chip } from './derive.js';
import { useModelChoices } from '../ui/ModelPicker.js';

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
 */
export function JobsPage({
  api,
  jobs: allJobs,
  error: allError,
  refresh: refreshAll,
  query,
  pollMs,
}: {
  api: Api;
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
  const [mine, setMine] = useState(loadMine);
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
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
  const now = Date.now();

  return (
    <div className="jobs-page">
      <div className="page-header">
        <div>
          <h1>Jobs</h1>
          <p className="muted">
            Every job: filter by status, act on the ones that need you, clean up finished ones.
          </p>
        </div>
        {pollMs > 0 && (
          <span className={error ? 'live live-warn' : 'live'}>
            <span className="live-dot" aria-hidden="true" />
            {error ? 'Reconnecting…' : `Live · refreshes every ${pollMs / 1000} s`}
          </span>
        )}
      </div>
      {error && <p role="alert">Failed to load jobs: {error}</p>}
      <div className="jobs-layout">
        <section className="jobs-main" aria-label="Job list">
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
          </div>
          {mine && mineJobs.loaded && jobs.length === 0 && !error ? (
            <p>You have not queued any jobs yet.</p>
          ) : jobs.length > 0 && visible.length === 0 ? (
            <p>{query.trim() ? `No jobs match “${query.trim()}”.` : 'No jobs in this view.'}</p>
          ) : (
            <JobList
              api={api}
              jobs={visible}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
              onChanged={refresh}
              models={models}
              specTitles={specTitles}
              typeModels={typeModels}
              now={now}
            />
          )}
          <div className="list-footer">
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
