import { OVERVIEW_LABEL, type OverviewEntry } from '@ih/shared';
import { stageStyle } from './stageStyle.js';

/** Ten segments, one per overview stage (handoff §1); the name spells out every stage. */
export function ProgressStrip({ stages }: { stages: readonly OverviewEntry[] }) {
  const said = (e: OverviewEntry) => `${OVERVIEW_LABEL[e.stage]} ${stageStyle(e.state).label}`;
  return (
    <span
      className="progress-strip"
      role="img"
      aria-label={`Progress: ${stages.map(said).join(', ')}`}
    >
      {stages.map((e) => (
        <span
          key={e.stage}
          className={`seg seg-${e.state}`}
          title={`${OVERVIEW_LABEL[e.stage]}: ${stageStyle(e.state).label}`}
        />
      ))}
    </span>
  );
}
