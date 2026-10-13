import {
  OVERVIEW_STAGES,
  OVERVIEW_TAB_LABEL,
  type OverviewItem,
  type OverviewTab,
  type ProjectOverview,
} from '@ih/shared';
import type { CSSProperties } from 'react';
import { relativeTime } from '../jobs/derive.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { PhasePanel } from '../ui/PhasePanel.js';
import { StageStatusIcon } from '../ui/StageStatusIcon.js';
import { stageStyle, TONE_COLOR } from '../ui/stageStyle.js';
import { TAB_ICON } from './ProjectRail.js';

export interface MapBox {
  tab: OverviewTab;
  number: string | null;
  col: 0 | 1 | 2 | 3;
  row: 0 | 1 | 2;
}

const GRID: Omit<MapBox, 'number'>[] = [
  { tab: 'samples', col: 0, row: 0 },
  { tab: 'brief', col: 1, row: 0 },
  { tab: 'template', col: 2, row: 0 },
  { tab: 'runs', col: 3, row: 0 },
  { tab: 'survey', col: 0, row: 1 },
  { tab: 'outputs', col: 1, row: 1 },
  { tab: 'sections', col: 2, row: 1 },
  { tab: 'steps', col: 3, row: 1 },
  { tab: 'references', col: 0, row: 2 },
  { tab: 'evaluate', col: 1, row: 2 },
  { tab: 'revise', col: 2, row: 2 },
  { tab: 'publish', col: 3, row: 2 },
];

/** The twelve map boxes on the handoff's 4×3 grid; the ten stages are numbered 01–10. */
export const MAP_BOXES: MapBox[] = GRID.map((b) => {
  const i = (OVERVIEW_STAGES as readonly string[]).indexOf(b.tab);
  return { ...b, number: i >= 0 ? String(i + 1).padStart(2, '0') : null };
});

const PANELS = [
  { title: 'Prepare', range: 'stages 1–2', x: 8, y: 8, w: 484 },
  { title: 'Edit and test by hand', range: 'any time', x: 528, y: 8, w: 484 },
  { title: 'Draft with the model', range: 'stages 3–6', x: 8, y: 208, w: 1004 },
  { title: 'Verify and publish', range: 'stages 7–10', x: 8, y: 408, w: 1004 },
];

const FLOW = [
  'M220 106H278', // Samples → Brief
  'M740 106H798', // Template → Test runs
  'M220 306H278', // Survey → Outputs
  'M480 306H538', // Outputs → Sections
  'M740 306H798', // Sections → Steps
  'M220 506H278', // References → Evaluate
  'M480 506H538', // Evaluate → Revise
  'M380 168V206H190V242', // Brief → Survey
  'M900 368V404H190V442', // Steps → References
  'M380 568V606H900V570', // Evaluate → Publish
];
const SIDE = ['M640 168V242', 'M640 444V370']; // Template → Sections, Revise → Sections

const BOX_TOP = [44, 244, 444];

const target = (tab: OverviewTab) => (tab === 'publish' ? 'evaluate' : tab);
const icon = (tab: OverviewTab): IconName => (tab === 'publish' ? 'upload' : TAB_ICON[tab]);

function title(tab: OverviewTab, overview: ProjectOverview) {
  return tab === 'publish' && overview.project.draft !== null
    ? `Publish v${overview.project.draft}`
    : OVERVIEW_TAB_LABEL[tab];
}

function Box({
  item,
  number,
  projectId,
  overview,
  now,
  style,
}: {
  item: OverviewItem;
  number: string | null;
  projectId: string;
  overview: ProjectOverview;
  now: number;
  style?: CSSProperties;
}) {
  const s = stageStyle(item.state);
  const tone = TONE_COLOR[s.tone];
  const name = title(item.stage, overview);
  const next = overview.next?.stage === item.stage;
  return (
    <a
      className={next ? 'map-box is-next' : 'map-box'}
      data-state={item.state}
      href={`#/workbench/${projectId}/${target(item.stage)}`}
      aria-label={`${name}: ${item.status}. Open the ${OVERVIEW_TAB_LABEL[target(item.stage)]} tab`}
      style={{
        ...style,
        background: s.fill,
        borderColor: item.state === 'accepted' ? 'var(--ih-border)' : tone,
      }}
    >
      <span className="map-box-head">
        <span
          className="map-box-tile"
          style={{ color: tone, boxShadow: `inset 0 0 0 1px ${tone}` }}
        >
          <Icon name={icon(item.stage)} size={16} />
        </span>
        <span className="map-box-title">{name}</span>
        <StageStatusIcon state={item.state} decorative />
      </span>
      <span className="map-box-status" style={{ color: tone }}>
        {number && <span className="map-box-number">{number}</span>}
        {item.status}
      </span>
      <span className="map-box-metrics">
        {item.metrics.map((metric) => (
          <span key={metric.label} className="map-box-metric">
            <span>{metric.label}</span>
            <span>{metric.at ? relativeTime(metric.at, now) : metric.value}</span>
          </span>
        ))}
      </span>
    </a>
  );
}

function itemFor(overview: ProjectOverview, tab: OverviewTab): OverviewItem {
  return (
    overview.stages.find((s) => s.stage === tab) ?? {
      stage: tab,
      state: 'pending',
      status: 'Not started',
      metrics: [],
    }
  );
}

/** The Overview process map (handoff §3): a fixed 1020×640 canvas in a scroll box. */
export function OverviewMap({
  projectId,
  overview,
  now,
}: {
  projectId: string;
  overview: ProjectOverview;
  now: number;
}) {
  return (
    <section className="map-scroll" aria-label="Process map">
      <div className="map-canvas">
        {PANELS.map((p) => (
          <PhasePanel
            key={p.title}
            title={p.title}
            range={p.range}
            className="map-panel"
            style={{ left: p.x, top: p.y, width: p.w, height: 172 }}
          />
        ))}
        <svg
          className="map-connectors"
          width="1020"
          height="640"
          viewBox="0 0 1020 640"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <marker
              id="map-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="4.5"
              markerHeight="4.5"
              orient="auto-start-reverse"
            >
              <path d="M0 0L10 5L0 10z" style={{ fill: 'var(--ih-flow)' }} />
            </marker>
            <marker
              id="map-arrow-side"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="4.5"
              markerHeight="4.5"
              orient="auto-start-reverse"
            >
              <path d="M0 0L10 5L0 10z" style={{ fill: 'var(--ih-side)' }} />
            </marker>
          </defs>
          {FLOW.map((d) => (
            <path
              key={d}
              d={d}
              fill="none"
              strokeWidth={3}
              markerEnd="url(#map-arrow)"
              style={{ stroke: 'var(--ih-flow)' }}
            />
          ))}
          {SIDE.map((d) => (
            <path
              key={d}
              d={d}
              fill="none"
              strokeWidth={2.5}
              strokeDasharray="7 5"
              markerEnd="url(#map-arrow-side)"
              style={{ stroke: 'var(--ih-side)' }}
            />
          ))}
        </svg>
        <span className="map-edge flow" style={{ left: 640, top: 606 }}>
          publish when the gate passes
        </span>
        <span className="map-edge side" style={{ left: 648, top: 205 }}>
          hand edits change the draft
        </span>
        <span className="map-edge side" style={{ left: 648, top: 407 }}>
          revision changes the draft
        </span>
        {MAP_BOXES.map((b) => (
          <Box
            key={b.tab}
            item={itemFor(overview, b.tab)}
            number={b.number}
            projectId={projectId}
            overview={overview}
            now={now}
            style={{ left: 20 + 260 * b.col, top: BOX_TOP[b.row] }}
          />
        ))}
      </div>
    </section>
  );
}

const STACK_GROUPS: { title: string; tabs: OverviewTab[] }[] = [
  { title: 'Prepare', tabs: ['samples', 'brief'] },
  { title: 'Draft with the model', tabs: ['survey', 'outputs', 'sections', 'steps'] },
  { title: 'Verify and publish', tabs: ['references', 'evaluate', 'revise', 'publish'] },
  { title: 'Edit and test by hand', tabs: ['template', 'runs'] },
];

/** The map's boxes as a list, for narrow screens (handoff §3 mobile). */
export function OverviewStack({
  projectId,
  overview,
  now,
}: {
  projectId: string;
  overview: ProjectOverview;
  now: number;
}) {
  const number = (tab: OverviewTab) => MAP_BOXES.find((b) => b.tab === tab)?.number ?? null;
  return (
    <div className="map-stack" role="group" aria-label="Stages">
      {STACK_GROUPS.map((g) => (
        <section key={g.title} className="map-stack-group">
          <h3>{g.title}</h3>
          {g.tabs.map((tab) => (
            <Box
              key={tab}
              item={itemFor(overview, tab)}
              number={number(tab)}
              projectId={projectId}
              overview={overview}
              now={now}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
