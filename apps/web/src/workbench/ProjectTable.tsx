import { percent, type ProjectListItem } from '@ih/shared';
import { relativeTime } from '../jobs/derive.js';
import { NextAction } from '../ui/NextAction.js';
import { ProgressStrip } from '../ui/ProgressStrip.js';
import { formatCount, nextHref, phaseLine } from './listDerive.js';

const projectHref = (id: string) => `#/workbench/${id}`;

/** Star toggle; filled amber when the project is pinned. */
export function PinButton({
  name,
  pinned,
  onToggle,
}: {
  name: string;
  pinned: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="pin-button"
      aria-pressed={pinned}
      aria-label={`Pin ${name}`}
      onClick={onToggle}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <path
          d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"
          fill={pinned ? 'var(--ih-warn-fg)' : 'none'}
          stroke={pinned ? 'var(--ih-warn-fg)' : 'var(--ih-muted)'}
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** Holdout score with an 84 px bar; the tick marks the project's publish threshold. */
export function ScoreBar({ score, threshold }: { score: number | null; threshold: number }) {
  const label =
    score === null
      ? `No holdout score; publish threshold ${percent(threshold)}`
      : `Holdout score ${percent(score)}, publish threshold ${percent(threshold)}`;
  const tone = score === null ? undefined : score >= threshold ? 'ok' : 'warn';
  const pct = (x: number) => `${Math.min(100, Math.max(0, x * 100))}%`;
  return (
    <span className="score">
      <span className="score-value" data-tone={tone}>
        {score === null ? '—' : percent(score)}
      </span>
      <span className="score-bar" role="img" aria-label={label}>
        {score !== null && (
          <span className="score-fill" data-tone={tone} style={{ width: pct(score) }} />
        )}
        <span className="score-tick" style={{ left: pct(threshold) }} />
      </span>
    </span>
  );
}

function Versions({ item }: { item: ProjectListItem }) {
  return (
    <span className="versions">
      <span className={item.draft === null ? undefined : 'versions-draft'}>
        {item.draft === null ? '—' : `Draft v${item.draft}`}
      </span>
      <span className="muted">
        {item.published === null ? 'Not published' : `Live v${item.published}`}
      </span>
    </span>
  );
}

function NextLink({ item }: { item: ProjectListItem }) {
  return item.next === null ? null : <NextAction action={item.next} href={nextHref(item)} />;
}

/** A project as a card: the phone list, and the pinned and recent strips. */
export function ProjectCard({
  item,
  pinned = false,
  onTogglePin,
  now,
}: {
  item: ProjectListItem;
  pinned?: boolean;
  onTogglePin?: () => void;
  now: number;
}) {
  return (
    <article className="project-card">
      <header className="project-card-head">
        {onTogglePin && <PinButton name={item.name} pinned={pinned} onToggle={onTogglePin} />}
        <a className="project-name" href={projectHref(item.id)}>
          {item.name}
        </a>
        {item.dataPolicy === 'external' && <span className="ext-tag">EXT</span>}
        <span className="muted project-card-time">{relativeTime(item.lastActivityAt, now)}</span>
      </header>
      <ProgressStrip stages={item.stages} />
      <span className="muted project-phase">{phaseLine(item)}</span>
      <NextLink item={item} />
    </article>
  );
}

export function ProjectTable({
  items,
  pinned,
  onTogglePin,
  now,
}: {
  items: readonly ProjectListItem[];
  pinned: ReadonlySet<string>;
  onTogglePin: (id: string) => void;
  now: number;
}) {
  return (
    <section aria-label="Projects" className="projects">
      <div className="projects-scroll">
        <table className="projects-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Pin</span>
              </th>
              <th scope="col">Document type</th>
              <th scope="col">Progress</th>
              <th scope="col">Next action</th>
              <th scope="col">Versions</th>
              <th scope="col">Holdout score</th>
              <th scope="col">Samples</th>
              <th scope="col">Activity</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <PinButton
                    name={item.name}
                    pinned={pinned.has(item.id)}
                    onToggle={() => onTogglePin(item.id)}
                  />
                </td>
                <td>
                  <span className="project-title">
                    <a className="project-name" href={projectHref(item.id)}>
                      {item.name}
                    </a>
                    {item.dataPolicy === 'external' && <span className="ext-tag">EXT</span>}
                  </span>
                  <span className="project-id mono">{item.id}</span>
                </td>
                <td>
                  <ProgressStrip stages={item.stages} />
                  <span className="muted project-phase">{phaseLine(item)}</span>
                </td>
                <td>
                  <NextLink item={item} />
                </td>
                <td>
                  <Versions item={item} />
                </td>
                <td>
                  <ScoreBar score={item.holdoutScore} threshold={item.publishThreshold} />
                </td>
                <td>
                  <span className="samples">
                    <span>{formatCount(item.samples)}</span>
                    <span className="muted">
                      {formatCount(item.devSamples)} dev · {formatCount(item.holdoutSamples)} hold
                    </span>
                  </span>
                </td>
                <td className="muted">{relativeTime(item.lastActivityAt, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="project-cards" aria-label="Projects as cards">
        {items.map((item) => (
          <li key={item.id}>
            <ProjectCard
              item={item}
              pinned={pinned.has(item.id)}
              onTogglePin={() => onTogglePin(item.id)}
              now={now}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
