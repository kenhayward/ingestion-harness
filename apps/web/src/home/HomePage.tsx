import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobProgress, JobSummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { JobDetailPanel } from '../jobs/JobDetailPanel.js';
import { UploadStrip } from '../jobs/UploadStrip.js';
import { useModelChoices } from '../ui/ModelPicker.js';

/** The newest job queued by `me`, else the newest job of all (null without jobs). */
export function latestJob(jobs: readonly JobSummary[], me: string): JobSummary | null {
  const newest = (list: readonly JobSummary[]) =>
    list.reduce<JobSummary | null>(
      (best, j) => (best === null || j.createdAt > best.createdAt ? j : best),
      null,
    );
  return newest(jobs.filter((j) => j.createdBy === me)) ?? newest(jobs);
}

const isActive = (j: JobSummary) => j.status === 'queued' || j.status === 'running';

/**
 * Follow one job closely while it is queued or running: its live stream pushes every change
 * (`api.watchJob`); where the stream is not available it is re-read every `ms` instead. Returns
 * the fresher copy, where the run is, and a tick that moves on every update (the panel re-reads
 * the step runs); `onFinished` runs once the job leaves running or is deleted.
 */
function useLiveJob(
  api: Api,
  job: JobSummary | null,
  ms: number,
  onFinished: () => void,
): { job: JobSummary | null; progress: JobProgress | null; tick: number; following: boolean } {
  const [fresh, setFresh] = useState<JobSummary | null>(null);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [tick, setTick] = useState(0);
  /** The job whose stream failed: it is polled instead. */
  const [pollingFor, setPollingFor] = useState<string | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  // The fresher of the list's copy and ours (a reload of the list may be the newer one).
  const current =
    job && fresh && fresh.id === job.id && fresh.updatedAt >= job.updatedAt ? fresh : job;
  const following = ms > 0 && current !== null && isActive(current);
  const id = following ? current.id : null;
  const polling = id !== null && pollingFor === id;

  const seen = useCallback((summary: JobSummary, now: JobProgress | null) => {
    setFresh(summary);
    setProgress(now);
    setTick((t) => t + 1);
    if (!isActive(summary)) finished.current();
  }, []);

  useEffect(() => {
    if (id === null || polling) return;
    return api.watchJob(id, {
      update: (live) => seen(live.job, live.progress),
      gone: () => finished.current(),
      error: () => setPollingFor(id),
    });
  }, [api, id, polling, seen]);

  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const detail = await api.getJob(id);
        if (stopped) return;
        seen(detail, detail.progress ?? null);
        if (!isActive(detail)) return; // the effect ends with `following`
      } catch {
        if (stopped) return; // a missed read: the list poll still runs, try again next tick
      }
      timer = setTimeout(() => void read(), ms);
    };
    timer = setTimeout(() => void read(), ms);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, id, ms, polling, seen]);

  const live = current !== null && fresh?.id === current.id && current.status === 'running';
  return { job: current, progress: live ? progress : null, tick, following };
}

/**
 * Home: upload documents, then watch the latest one run (the job you queued last, else the
 * newest job). The full list, filters and clean-up are on Jobs.
 */
export function HomePage({
  api,
  me,
  jobs,
  error,
  refresh,
  pollMs,
  livePollMs = 1000,
  pickPending,
  onPicked,
}: {
  api: Api;
  /** The signed-in token's label (jobs record it as `createdBy`). */
  me: string;
  jobs: readonly JobSummary[];
  /** The last poll failed with this message (the card shows the previous result). */
  error: string | null;
  refresh: () => Promise<void>;
  /** Poll interval, for the live indicator; <= 0 = not polling. */
  pollMs: number;
  /** While the latest job is queued or running it is re-read this often; <= 0 = never. */
  livePollMs?: number;
  /** Upload document (top bar) was pressed: the upload strip opens the file picker. */
  pickPending: boolean;
  onPicked: () => void;
}) {
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
  const live = useLiveJob(api, latestJob(jobs, me), pollMs > 0 ? livePollMs : 0, () => {
    void refresh();
  });
  const latest = live.job;

  return (
    <div className="home-page">
      <div className="page-header">
        <div>
          <h1>Home</h1>
          <p className="muted">
            Upload a PDF or Word document, watch it run, review what was extracted.
          </p>
        </div>
        {pollMs > 0 && (
          <span className={error ? 'live live-warn' : 'live'}>
            <span className="live-dot" aria-hidden="true" />
            {error
              ? 'Reconnecting…'
              : live.following
                ? 'Live · following this job'
                : `Live · refreshes every ${pollMs / 1000} s`}
          </span>
        )}
      </div>
      <section aria-labelledby="home-upload-heading">
        <h2 id="home-upload-heading" className="section-heading">
          Upload documents
        </h2>
        <UploadStrip
          api={api}
          onUploaded={() => void refresh()}
          pickPending={pickPending}
          onPicked={onPicked}
        />
      </section>
      {error && <p role="alert">Failed to load jobs: {error}</p>}
      {latest ? (
        <JobDetailPanel
          key={latest.id}
          api={api}
          job={latest}
          onChanged={() => void refresh()}
          models={models}
          specTitles={specTitles}
          typeModels={typeModels}
          now={Date.now()}
          wide
          liveTick={live.tick}
          progress={live.progress}
        />
      ) : (
        <p className="muted">No jobs yet: upload a document to start.</p>
      )}
    </div>
  );
}
