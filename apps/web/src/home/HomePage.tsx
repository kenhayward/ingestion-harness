import { useEffect, useState } from 'react';
import type { JobSummary } from '@ih/shared';
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
  /** Upload document (top bar) was pressed: the upload strip opens the file picker. */
  pickPending: boolean;
  onPicked: () => void;
}) {
  const models = useModelChoices(api);
  const [specTitles, setSpecTitles] = useState<ReadonlyMap<string, string>>(new Map());
  /** Each type's model, from its newest version (what Retry and Re-process run on). */
  const [typeModels, setTypeModels] = useState<ReadonlyMap<string, { model?: string }>>(new Map());
  useEffect(() => {
    api.listSpecs().then(
      (specs) => {
        setSpecTitles(new Map(specs.map((s) => [s.id, s.title])));
        // Listed oldest version first: the newest one wins.
        setTypeModels(new Map(specs.map((s) => [s.id, s.model ? { model: s.model } : {}])));
      },
      () => {}, // titles are cosmetic: ids are shown instead
    );
  }, [api]);
  const latest = latestJob(jobs, me);

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
            {error ? 'Reconnecting…' : `Live · refreshes every ${pollMs / 1000} s`}
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
        />
      ) : (
        <p className="muted">No jobs yet: upload a document to start.</p>
      )}
    </div>
  );
}
