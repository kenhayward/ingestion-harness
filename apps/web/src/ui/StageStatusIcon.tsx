import type { CSSProperties } from 'react';
import { stageStyle, TONE_COLOR, type DisplayState, type StageStyle } from './stageStyle.js';

function circleStyle(style: StageStyle, color: string): CSSProperties {
  if (style.circle === 'filled') return { fill: color, stroke: color };
  if (style.circle === 'track') return { fill: 'none', stroke: 'var(--ih-border)' };
  return { fill: 'none', stroke: color };
}

/**
 * A stage's status as a 20×20 icon (handoff §2). Colours via `style`: CSS variables do not
 * resolve in SVG presentation attributes. `decorative` when nearby text already says the status.
 */
export function StageStatusIcon({
  state,
  label,
  size = 20,
  decorative = false,
}: {
  state: DisplayState;
  label?: string;
  size?: number;
  decorative?: boolean;
}) {
  const style = stageStyle(state);
  if (style.circle === 'none') return null;
  const color = TONE_COLOR[style.tone];
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img', 'aria-label': label ?? style.label };
  return (
    <svg
      className={state === 'running' ? 'stage-icon spin' : 'stage-icon'}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      focusable="false"
      data-state={state}
      {...a11y}
    >
      <circle
        cx="10"
        cy="10"
        r="8.25"
        strokeWidth={2}
        strokeDasharray={style.circle === 'dashed' ? '2.6 2.6' : undefined}
        style={circleStyle(style, color)}
      />
      {style.glyph && (
        <path
          d={style.glyph}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ stroke: style.circle === 'filled' ? 'var(--ih-surface)' : color }}
        />
      )}
    </svg>
  );
}

const LEGEND: DisplayState[] = [
  'accepted',
  'proposed',
  'running',
  'stale',
  'skipped',
  'locked',
  'pending',
];

/** Icon + words for each state shown nearby (rail, list footer). */
export function StageLegend({
  states = LEGEND,
  label = 'Status legend',
}: {
  states?: DisplayState[];
  label?: string;
}) {
  return (
    <ul className="stage-legend" aria-label={label}>
      {states.map((state) => (
        <li key={state}>
          <StageStatusIcon state={state} size={14} decorative />
          {stageStyle(state).label}
        </li>
      ))}
    </ul>
  );
}
