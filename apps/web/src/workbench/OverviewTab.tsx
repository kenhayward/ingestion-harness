import { OVERVIEW_TAB_LABEL, type ProjectOverview } from '@ih/shared';
import { StageStatusIcon } from '../ui/StageStatusIcon.js';
import { stageStyle } from '../ui/stageStyle.js';

/** Overview tab (handoff §3): the Next banner, then every step's status. PR 4 adds the map. */
export function OverviewTab({
  projectId,
  overview,
}: {
  projectId: string;
  overview: ProjectOverview;
}) {
  const { next } = overview;
  const target = next ? (next.stage === 'publish' ? 'evaluate' : next.stage) : null;
  const tone = next
    ? stageStyle(overview.stages.find((s) => s.stage === next.stage)?.state ?? 'none').tone
    : null;
  return (
    <div className="overview">
      {next && target && (
        <div role="note" className="next-banner" data-tone={tone ?? undefined}>
          <div>
            <strong>{next.title}</strong>
            {next.reason && <p>{next.reason}</p>}
          </div>
          <a className="button primary" href={`#/workbench/${projectId}/${target}`}>
            Open {OVERVIEW_TAB_LABEL[target]}
          </a>
        </div>
      )}
      <ul className="overview-list" aria-label="Stages">
        {overview.stages.map((s) => (
          <li key={s.stage}>
            <a
              href={`#/workbench/${projectId}/${s.stage === 'publish' ? 'evaluate' : s.stage}`}
              aria-label={`${OVERVIEW_TAB_LABEL[s.stage]}: ${s.status}`}
            >
              <StageStatusIcon state={s.state} decorative />
              <span>{OVERVIEW_TAB_LABEL[s.stage]}</span>
              <span className="muted">{s.status}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
