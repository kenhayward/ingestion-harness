import { useId } from 'react';
import type { JobSummary, ModelChoice } from '@ih/shared';
import type { ReviewData } from '../api/client.js';
import { modelLabel } from '../jobs/derive.js';
import { HelpButton } from '../ui/Help.js';
import { Icon } from '../ui/Icon.js';
import { StatusPill } from '../ui/StatusPill.js';
import { usePopover } from '../ui/usePopover.js';
import { reviewQueue } from './queue.js';

/**
 * Review header on one row (review header handoff, option A): back link, file, status, the
 * reasons chip while the job awaits review, recipe · version · model, queue position, Next
 * document and help.
 */
export function ReviewHeader({
  data,
  jobs,
  jobId,
  models,
  onManageConnections,
}: {
  data: ReviewData;
  /** Opens the bridge's connections page (a review held up by a connection). */
  onManageConnections?: () => void;
  jobs: readonly JobSummary[];
  jobId: string;
  models: readonly ModelChoice[];
}) {
  const { job, template } = data;
  const queue = reviewQueue(jobs, jobId);
  const reasons = job.status === 'awaiting_review' ? (job.reviewReasons ?? []) : [];
  const meta = `${template.name} · v${template.version} · ${modelLabel(job, models)}`;

  return (
    <header className="review-header">
      <a className="back-link" href="#/jobs">
        <Icon name="chevronLeft" />
        Jobs
      </a>
      <span className="review-header-rule" aria-hidden="true" />
      <h1 title={job.filename}>{job.filename}</h1>
      <StatusPill status={job.status} />
      {reasons.length > 0 && (
        <ReasonsChip
          reasons={reasons}
          onManageConnections={data.connectionNeeded ? onManageConnections : undefined}
        />
      )}
      <span className="review-meta muted" title={meta}>
        {meta}
      </span>
      {queue.total > 0 && (
        <div className="review-queue">
          <span className="muted">
            {queue.position === null
              ? `${queue.total} awaiting review`
              : `${queue.position} of ${queue.total} awaiting review`}
          </span>
          {queue.next && (
            <a className="button small" href={`#/review/${queue.next}`}>
              Next document
              <Icon name="chevronRight" />
            </a>
          )}
        </div>
      )}
      <HelpButton topic="review" />
    </header>
  );
}

/**
 * What flagged the job for review, behind an amber chip (closed until asked for). With
 * `onManageConnections`, a delivery needs a connection and the reasons offer the page for it.
 */
function ReasonsChip({
  reasons,
  onManageConnections,
}: {
  reasons: readonly string[];
  onManageConnections?: () => void;
}) {
  const p = usePopover();
  const headingId = useId();
  return (
    <div className="popover-anchor reasons-anchor" ref={p.box} onKeyDown={p.onKeyDown}>
      <button
        type="button"
        ref={p.trigger}
        className="reasons-chip"
        aria-haspopup="dialog"
        aria-expanded={p.open}
        aria-label={`Why this needs review (${reasons.length})`}
        onClick={() => p.setOpen(!p.open)}
      >
        <Icon name="flag" />
        Why review · {reasons.length}
        <Icon name="chevronDown" />
      </button>
      {p.open && (
        <div className="dropdown-pop reasons-pop" role="dialog" aria-labelledby={headingId}>
          <strong id={headingId}>Why this needs review</strong>
          <ul>
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {onManageConnections && (
            <p>
              A delivery needs a connection: add or fix it, then approve again.{' '}
              <button type="button" onClick={onManageConnections}>
                <Icon name="key" />
                Manage connections
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
