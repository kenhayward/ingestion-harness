import { useEffect, useId, useState } from 'react';
import type { JobOutput, JobProgress, JobSummary, ModelChoice, StepRun } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { StatusPill } from '../ui/StatusPill.js';
import { JobActions } from './JobActions.js';
import { modelLabel, progressSteps, relativeTime } from './derive.js';

/** The callout for a job someone has to act on (or that stopped). */
function callout(job: JobSummary): { title: string; lines: string[]; tone: string } | null {
  switch (job.status) {
    case 'awaiting_review':
      return { title: 'Needs a reviewer', lines: job.reviewReasons ?? [], tone: 'warn' };
    case 'needs_review':
      return {
        title: 'Stopped — operator action needed',
        lines: job.error ? [job.error] : [],
        tone: 'alert',
      };
    case 'failed':
      return { title: 'Failed', lines: job.error ? [job.error] : [], tone: 'danger' };
    case 'rejected':
      return { title: 'Rejected', lines: job.reviewNote ? [job.reviewNote] : [], tone: 'neutral' };
    case 'cancelled':
      return { title: 'Cancelled', lines: [], tone: 'neutral' };
    default:
      return null;
  }
}

/** "3 files: 2 CSV, 1 JSON": what the ZIP holds. */
function filesText(outputs: readonly JobOutput[]): string {
  const byFormat = new Map<string, number>();
  for (const o of outputs) byFormat.set(o.format, (byFormat.get(o.format) ?? 0) + 1);
  const parts = [...byFormat].map(([format, n]) => `${n} ${format.toUpperCase()}`);
  const n = outputs.length;
  return `${n} ${n === 1 ? 'file' : 'files'}: ${parts.join(', ')}`;
}

/** Job detail panel (UI handoff §1): what happened, what came out, what to do next. */
export function JobDetailPanel({
  api,
  job,
  onChanged,
  models,
  specTitles,
  typeModels,
  now,
  wide = false,
  liveTick,
  progress: runProgress = null,
}: {
  api: Api;
  job: JobSummary;
  onChanged: () => void;
  models: readonly ModelChoice[];
  specTitles: ReadonlyMap<string, string>;
  /** Each document type's model, by id (unknown types: no name in the dialog). */
  typeModels?: ReadonlyMap<string, { model?: string }>;
  now: number;
  /** Home: one wide card (summary, progress and facts side by side) instead of a side panel. */
  wide?: boolean;
  /** Home's live follow: bumped on each quick poll so step runs are re-read while it runs. */
  liveTick?: number;
  /** Home's live follow: where the running job is (null: not known). */
  progress?: JobProgress | null;
}) {
  const [outputs, setOutputs] = useState<JobOutput[] | null>(null);
  const [runs, setRuns] = useState<StepRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reload when the job moves on (status, retry, edits); ignore answers for a job left behind.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.getJob(job.id).then(
      (d) => {
        if (!cancelled) setOutputs(d.outputs);
      },
      (err: Error) => {
        if (!cancelled) setError(err.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, job.id, job.status, job.updatedAt]);
  // Step runs are also re-read on each live update (Home): a recorded step moves the progress.
  useEffect(() => {
    let cancelled = false;
    api.getStepRuns(job.id).then(
      (r) => {
        if (!cancelled) setRuns(r);
      },
      (err: Error) => {
        if (!cancelled) setError(err.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, job.id, job.status, job.updatedAt, liveTick]);

  const note = callout(job);
  // Only delivered outputs are offered: drafts (awaiting review, test runs) are not deliverables.
  const published = (outputs ?? []).filter((o) => o.stage === 'published');

  const ids = useId();

  const calloutBlock = note && (
    <div role="note" className={`callout tone-${note.tone}`}>
      <span>
        <strong>{note.title}</strong>
        {note.lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    </div>
  );
  const progress = (
    <ol className="progress" aria-label="Progress">
      {progressSteps(job, runs, runProgress).map((step) => (
        <li key={step.label} className={`step-${step.state}`}>
          <span className="step-icon" aria-hidden="true" />
          <span className="step-label">{step.label}</span>
          <span className="step-state">{step.text}</span>
        </li>
      ))}
    </ol>
  );
  const meta = (
    <dl className="meta">
      <dt>Document type</dt>
      <dd>
        {specTitles.get(job.specId) ?? job.specId} v{job.specVersion}
      </dd>
      <dt>Model</dt>
      <dd>{modelLabel(job, models)}</dd>
      <dt>Attempts</dt>
      <dd>{job.attempts}</dd>
      <dt>Created</dt>
      <dd title={new Date(job.createdAt).toLocaleString()}>{relativeTime(job.createdAt, now)}</dd>
      {job.createdBy !== null && (
        <>
          <dt>Queued by</dt>
          <dd>{job.createdBy}</dd>
        </>
      )}
    </dl>
  );
  const errorLine = error && <p className="error">Couldn't load details: {error}</p>;
  const actions = (
    <JobActions
      api={api}
      job={job}
      onChanged={onChanged}
      models={models}
      typeModel={typeModels?.get(job.specId)}
      variant="panel"
    />
  );
  const download = (
    <>
      <a href={api.archiveUrl(job.id)} aria-label={`Download ${job.filename} outputs as ZIP`}>
        <Icon name="download" />
        Download outputs (ZIP)
      </a>
      <p className="muted">{filesText(published)}</p>
    </>
  );

  if (wide) {
    const id = (name: string) => `${ids}-${name}`;
    return (
      <aside className="job-panel wide" aria-label="Job details">
        <header className="job-head">
          <h3 className="card-label">Latest job</h3>
          <div className="job-title">
            <h2>{job.filename}</h2>
            <StatusPill status={job.status} />
          </div>
        </header>
        <section className="job-progress" aria-labelledby={id('progress')}>
          <h3 className="card-label" id={id('progress')}>
            Progress
          </h3>
          {progress}
        </section>
        <div className="job-columns">
          <section className="job-status" aria-labelledby={id('status')}>
            <h3 className="card-label" id={id('status')}>
              Status and actions
            </h3>
            {calloutBlock}
            {errorLine}
            {actions}
            {published.length > 0 && (
              <section className="outputs" aria-labelledby={id('outputs')}>
                <h3 className="card-label" id={id('outputs')}>
                  Published outputs
                </h3>
                {download}
              </section>
            )}
          </section>
          <section className="job-details" aria-labelledby={id('details')}>
            <h3 className="card-label" id={id('details')}>
              Details
            </h3>
            {meta}
          </section>
        </div>
      </aside>
    );
  }

  return (
    <aside className="job-panel" aria-label="Job details">
      <p className="eyebrow">Job details</p>
      <h2>{job.filename}</h2>
      <StatusPill status={job.status} />
      {calloutBlock}
      {progress}
      {meta}
      {errorLine}
      {published.length > 0 && (
        <section className="outputs" aria-label="Published outputs">
          <h3>Published outputs</h3>
          {download}
        </section>
      )}
      {actions}
    </aside>
  );
}
