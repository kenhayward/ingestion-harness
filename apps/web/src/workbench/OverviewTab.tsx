import { OVERVIEW_TAB_LABEL, type ProjectOverview } from '@ih/shared';
import { StageStatusIcon } from '../ui/StageStatusIcon.js';
import { stageStyle } from '../ui/stageStyle.js';
import { OverviewMap, OverviewStack } from './OverviewMap.js';

/** Overview tab (handoff §3): the Next banner, the process map (a stack on narrow screens). */
export function OverviewTab({
  projectId,
  overview,
  now = Date.now(),
}: {
  projectId: string;
  overview: ProjectOverview;
  now?: number;
}) {
  const { next } = overview;
  const target = next ? (next.stage === 'publish' ? 'evaluate' : next.stage) : null;
  const nextState = next
    ? (overview.stages.find((s) => s.stage === next.stage)?.state ?? 'none')
    : 'none';
  const tone = next ? stageStyle(nextState).tone : null;
  return (
    <div className="overview">
      {next && target && (
        <div role="note" className="next-banner" data-tone={tone ?? undefined}>
          <span className="next-banner-tile" style={{ background: stageStyle(nextState).fill }}>
            <StageStatusIcon state={nextState} decorative />
          </span>
          <div className="next-banner-text">
            <strong>{next.title}</strong>
            {next.reason && <p>{next.reason}</p>}
          </div>
          <a className="button primary" href={`#/workbench/${projectId}/${target}`}>
            Open {OVERVIEW_TAB_LABEL[target]}
          </a>
        </div>
      )}
      <OverviewMap projectId={projectId} overview={overview} now={now} />
      <OverviewStack projectId={projectId} overview={overview} now={now} />
      <p className="map-caption muted">
        Each panel groups the stages of one phase (its label sits top-right). Click any box to open
        its tab. Blue arrows are the order the stages run in; teal dashed arrows change the draft
        from outside the main flow. In the Draft phase the model proposes changes and you accept,
        edit or skip them.
      </p>
    </div>
  );
}
