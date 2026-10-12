import { useEffect, useState } from 'react';
import type { JobOutput, JobSummary, ModelInfo, StepRun } from '@ih/shared';
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

const fileName = (o: JobOutput) => o.key.split('/').pop() ?? `${o.outputId}.${o.format}`;

/** Job detail panel (UI handoff §1): what happened, what came out, what to do next. */
export function JobDetailPanel({
  api,
  job,
  onChanged,
  retryModel,
  models,
  specTitles,
  now,
}: {
  api: Api;
  job: JobSummary;
  onChanged: () => void;
  retryModel: string;
  models: readonly ModelInfo[];
  specTitles: ReadonlyMap<string, string>;
  now: number;
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
  const published = (outputs ?? []).filter((o) => o.stage === 'published');
  const shown = published.length ? published : (outputs ?? []).filter((o) => o.stage === 'draft');

  return (
    <aside className="job-panel" aria-label="Job details">
      <p className="eyebrow">Job details</p>
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
      </dl>
      {error && <p className="error">Couldn't load details: {error}</p>}
      {shown.length > 0 && (
        <section
          className="outputs"
          aria-label={published.length ? 'Published outputs' : 'Draft outputs'}
        >
          <h3>{published.length ? 'Published outputs' : 'Draft outputs'}</h3>
          {shown.map((o) => (
            <a
              key={`${o.stage}:${o.outputId}`}
              href={api.outputUrl(job.id, o.outputId, { stage: o.stage })}
            >
              <Icon name="download" />
              <span className="mono">{fileName(o)}</span>
              {o.format === 'csv' && o.rowCount !== null && <span>{o.rowCount} rows</span>}
            </a>
          ))}
        </section>
      )}
      <JobActions
        api={api}
        job={job}
        onChanged={onChanged}
        retryModel={retryModel}
        models={models}
        variant="panel"
      />
    </aside>
  );
}
