import { useEffect, useState } from 'react';
import type { JobOutput, JobSummary, ModelChoice, StepRun } from '@ih/shared';
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
  eyebrow = 'Job details',
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
  /** The small heading above the file name. */
  eyebrow?: string;
}) {
  const [outputs, setOutputs] = useState<JobOutput[] | null>(null);
  const [runs, setRuns] = useState<StepRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reload when the job moves on (status, retry, edits); ignore answers for a job left behind.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    const fail = (err: Error) => {
      if (!cancelled) setError(err.message);
    };
    api.getJob(job.id).then((d) => {
      if (!cancelled) setOutputs(d.outputs);
    }, fail);
    api.getStepRuns(job.id).then((r) => {
      if (!cancelled) setRuns(r);
    }, fail);
    return () => {
      cancelled = true;
    };
  }, [api, job.id, job.status, job.updatedAt]);

  const note = callout(job);
  // Only delivered outputs are offered: drafts (awaiting review, test runs) are not deliverables.
  const published = (outputs ?? []).filter((o) => o.stage === 'published');

  return (
    <aside className={wide ? 'job-panel wide' : 'job-panel'} aria-label="Job details">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{job.filename}</h2>
      <StatusPill status={job.status} />
      {note && (
        <div role="note" className={`callout tone-${note.tone}`}>
          <span>
            <strong>{note.title}</strong>
            {note.lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>
        </div>
      )}
      <ol className="progress" aria-label="Progress">
        {progressSteps(job, runs).map((step) => (
          <li key={step.label} className={`step-${step.state}`}>
            <span className="step-icon" aria-hidden="true" />
            <span className="step-label">{step.label}</span>
            <span className="step-state">{step.text}</span>
          </li>
        ))}
      </ol>
      <dl className="meta">
        <dt>Document type</dt>
        <dd>
          {specTitles.get(job.specId) ?? job.specId} v{job.specVersion}
        </dd>
        <dt>Model</dt>
        <dd className="mono">{modelLabel(job)}</dd>
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
      {error && <p className="error">Couldn't load details: {error}</p>}
      {published.length > 0 && (
        <section className="outputs" aria-label="Published outputs">
          <h3>Published outputs</h3>
          <a href={api.archiveUrl(job.id)} aria-label={`Download ${job.filename} outputs as ZIP`}>
            <Icon name="download" />
            Download outputs (ZIP)
          </a>
          <p className="muted">{filesText(published)}</p>
        </section>
      )}
      <JobActions
        api={api}
        job={job}
        onChanged={onChanged}
        models={models}
        typeModel={typeModels?.get(job.specId)}
        variant="panel"
      />
    </aside>
  );
}
