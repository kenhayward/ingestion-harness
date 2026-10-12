import { useEffect, useState } from 'react';
import type { JobSummary, ModelInfo } from '@ih/shared';
import type { Api } from '../api/client.js';
import { matchesQuery, statusGroup } from '../shell/derive.js';
import { FilterChips } from '../ui/FilterChips.js';
import { JobCleanup } from './JobCleanup.js';
import { JobDetailPanel } from './JobDetailPanel.js';
import { JobList } from './JobList.js';
import { UploadStrip } from './UploadStrip.js';
import { chipCounts, inChip, type Chip } from './derive.js';

const jobsText = (n: number) => `${n} ${n === 1 ? 'job' : 'jobs'}`;

/** Jobs (UI handoff §1): upload strip, status chips, job list + detail panel, clean-up. */
export function JobsPage({
  api,
  jobs,
  error,
  refresh,
  query,
  pollMs,
  pickPending,
  onPicked,
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
  pickPending: boolean;
  onPicked: () => void;
}) {
  /** The upload strip's Model selection; Retry and Re-process use it too. */
  const [retryModel, setRetryModel] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [specTitles, setSpecTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [models, setModels] = useState<ModelInfo[]>([]);

  useEffect(() => {
    api.listSpecs().then(
      (specs) => setSpecTitles(new Map(specs.map((s) => [s.id, s.title]))),
      () => {}, // titles are cosmetic: ids are shown instead
    );
    api.listModels().then(
      (list) => setModels(list.filter((m) => m.enabled)),
      () => setModels([]),
    );
  }, [api]);

  const counts = chipCounts(jobs);
  const visible = jobs.filter(
    (j) =>
      inChip(j, chip) &&
      matchesQuery(query, j.filename, j.specId, j.modelOverride, j.status, ...j.modelsUsed),
  );
  // The selection falls back (never stored) when its job is deleted or filtered out.
  const selected =
    visible.find((j) => j.id === selectedId) ??
    visible.find((j) => statusGroup(j.status) === 'attention') ??
    visible[0] ??
    null;
  const now = Date.now();

  return (
    <div className="jobs-page">
      <div className="page-header">
        <div>
          <h1>Jobs</h1>
          <p className="muted">Upload a PDF, watch it run, review what was extracted.</p>
        </div>
        {pollMs > 0 && (
          <span className={error ? 'live live-warn' : 'live'}>
            <span className="live-dot" aria-hidden="true" />
            {error ? 'Reconnecting…' : `Live · refreshes every ${pollMs / 1000} s`}
          </span>
        )}
      </div>
      <UploadStrip
        api={api}
        onUploaded={refresh}
        onModelChange={setRetryModel}
        pickPending={pickPending}
        onPicked={onPicked}
      />
      {error && <p role="alert">Failed to load jobs: {error}</p>}
      <div className="jobs-layout">
        <section className="jobs-main" aria-label="Job list">
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
          {jobs.length > 0 && visible.length === 0 ? (
            <p>{query.trim() ? `No jobs match “${query.trim()}”.` : 'No jobs in this view.'}</p>
          ) : (
            <JobList
              api={api}
              jobs={visible}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
              onChanged={refresh}
              retryModel={retryModel}
              models={models}
              specTitles={specTitles}
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
            retryModel={retryModel}
            models={models}
            specTitles={specTitles}
            now={now}
          />
        )}
      </div>
    </div>
  );
}
