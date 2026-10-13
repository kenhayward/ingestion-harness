import { useId } from 'react';
import type { JobSummary, ModelChoice } from '@ih/shared';
import type { ReviewData } from '../api/client.js';
import { modelLabel } from '../jobs/derive.js';
import { Icon } from '../ui/Icon.js';
import { StatusPill } from '../ui/StatusPill.js';
import { reviewQueue } from './queue.js';

/** Review header (UI handoff §2): back link, file, meta, queue position, Next document, reasons. */
export function ReviewHeader({
  data,
  jobs,
  jobId,
  models,
}: {
  data: ReviewData;
  jobs: readonly JobSummary[];
  jobId: string;
  models: readonly ModelChoice[];
}) {
  const reasonsId = useId();
  const { job, template } = data;
  const queue = reviewQueue(jobs, jobId);
  const reasons = job.reviewReasons ?? [];

  return (
    <>
      <header className="review-header">
        <div>
          <a className="back-link" href="#/jobs">
            <Icon name="chevronLeft" />
            Jobs
          </a>
          <h1>{job.filename}</h1>
          <p className="review-meta">
            <span>
              {template.name} · v{template.version}
            </span>
            <StatusPill status={job.status} />
            <span>{modelLabel(job, models)}</span>
          </p>
        </div>
        {queue.total > 0 && (
          <div className="review-queue">
            <span className="muted">
              {queue.position === null
                ? `${queue.total} awaiting review`
                : `${queue.position} of ${queue.total} awaiting review`}
            </span>
            {queue.next && (
              <a className="button" href={`#/review/${queue.next}`}>
                Next document
                <Icon name="chevronRight" />
              </a>
            )}
          </div>
        )}
      </header>
      {reasons.length > 0 && (
        <div className="why callout tone-warn" role="note" aria-labelledby={reasonsId}>
          <strong id={reasonsId}>Why this needs review</strong>
          <ul>
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
