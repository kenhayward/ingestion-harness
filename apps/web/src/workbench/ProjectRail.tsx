import { OVERVIEW_TAB_LABEL, type OverviewItem } from '@ih/shared';
import type { ProjectTab } from '../router.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { StageLegend, StageStatusIcon } from '../ui/StageStatusIcon.js';

export const TAB_ICON: Record<ProjectTab, IconName> = {
  overview: 'overview',
  samples: 'file',
  brief: 'brief',
  survey: 'search',
  outputs: 'results',
  sections: 'sections',
  steps: 'steps',
  references: 'shieldCheck',
  evaluate: 'bars',
  revise: 'message',
  template: 'code',
  runs: 'play',
};

const GROUPS: { heading: string | null; tabs: ProjectTab[] }[] = [
  { heading: null, tabs: ['overview'] },
  { heading: 'Prepare', tabs: ['samples', 'brief'] },
  { heading: 'Draft with the model', tabs: ['survey', 'outputs', 'sections', 'steps'] },
  { heading: 'Verify', tabs: ['references', 'evaluate', 'revise'] },
  { heading: 'By hand', tabs: ['template', 'runs'] },
];

const label = (tab: ProjectTab) => (tab === 'overview' ? 'Overview' : OVERVIEW_TAB_LABEL[tab]);

/** The project's own step rail (handoff §2); a select on small screens. */
export function ProjectRail({
  projectId,
  tab,
  items,
  onNavigate,
}: {
  projectId: string;
  tab: ProjectTab;
  items: OverviewItem[] | null;
  onNavigate: (hash: string) => void;
}) {
  const item = (t: ProjectTab) => items?.find((i) => i.stage === t) ?? null;
  const name = (t: ProjectTab) => {
    const i = item(t);
    return i && i.state !== 'none' ? `${label(t)}: ${i.status}` : label(t);
  };
  const href = (t: ProjectTab) => `#/workbench/${projectId}/${t}`;
  return (
    <>
      <label className="rail-select">
        <span className="visually-hidden">Project step</span>
        <select value={tab} onChange={(e) => onNavigate(href(e.target.value as ProjectTab))}>
          {GROUPS.flatMap((g) => g.tabs).map((t) => {
            const i = item(t);
            return (
              <option key={t} value={t}>
                {i && i.state !== 'none' ? `${label(t)} — ${i.status}` : label(t)}
              </option>
            );
          })}
        </select>
      </label>
      <nav className="project-rail" aria-label="Project steps">
        {GROUPS.map((g) => (
          <div key={g.heading ?? 'top'} className="rail-group">
            {g.heading && <h2 className="rail-heading">{g.heading}</h2>}
            {g.tabs.map((t) => {
              const i = item(t);
              return (
                <a
                  key={t}
                  href={href(t)}
                  aria-current={t === tab ? 'page' : undefined}
                  aria-label={name(t)}
                  title={name(t)}
                >
                  <Icon name={TAB_ICON[t]} size={17} />
                  <span className="rail-label">{label(t)}</span>
                  {i && <StageStatusIcon state={i.state} decorative />}
                </a>
              );
            })}
          </div>
        ))}
        <StageLegend />
      </nav>
    </>
  );
}
