import type { OverviewState } from '@ih/shared';

/** A stage state, or `none` for tabs without one (Overview, Template). */
export type DisplayState = OverviewState | 'none';
export type StageTone = 'ok' | 'warn' | 'accent' | 'alert' | 'skip' | 'lock' | 'neutral';

export interface StageStyle {
  /** Plain-words status: legends, tooltips, accessible names. */
  label: string;
  tone: StageTone;
  /** filled: tone disc + surface glyph; ring: tone outline + tone glyph; track: border ring + tone arc. */
  circle: 'filled' | 'ring' | 'track' | 'dashed' | 'none';
  glyph: string | null;
  /** Box fill on the Overview map. */
  fill: string;
}

const CHECK = 'M6 10.5l2.7 2.7L14 7.8';
const NEEDS_YOU = 'M10 5.6v5.2M10 14.1v.2';

/** The one state → style mapping (handoff §2): rail icons, map boxes, list segments, legends. */
const STYLES: Record<DisplayState, StageStyle> = {
  accepted: {
    label: 'Accepted',
    tone: 'ok',
    circle: 'filled',
    glyph: CHECK,
    fill: 'var(--ih-ok-bg)',
  },
  ready: {
    label: 'Ready to publish',
    tone: 'ok',
    circle: 'filled',
    glyph: CHECK,
    fill: 'var(--ih-ok-bg)',
  },
  proposed: {
    label: 'Needs you',
    tone: 'warn',
    circle: 'filled',
    glyph: NEEDS_YOU,
    fill: 'var(--ih-warn-bg)',
  },
  warn: {
    label: 'Needs you',
    tone: 'warn',
    circle: 'filled',
    glyph: NEEDS_YOU,
    fill: 'var(--ih-warn-bg)',
  },
  running: {
    label: 'Running',
    tone: 'accent',
    circle: 'track',
    glyph: 'M10 3.6a6.4 6.4 0 1 1-6.4 6.4',
    fill: 'var(--ih-info-bg)',
  },
  stale: {
    label: 'Stale',
    tone: 'alert',
    circle: 'filled',
    glyph: 'M13.6 8.2a4 4 0 1 0 .3 3.4M14 5v3.3h-3.3',
    fill: 'var(--ih-alert-bg)',
  },
  skipped: {
    label: 'Skipped',
    tone: 'skip',
    circle: 'ring',
    glyph: 'M6 10h7M10.4 7l3 3-3 3',
    fill: 'var(--ih-skip-bg)',
  },
  pending: {
    label: 'Not started',
    tone: 'neutral',
    circle: 'dashed',
    glyph: null,
    fill: 'var(--ih-surface)',
  },
  locked: {
    label: 'Locked',
    tone: 'lock',
    circle: 'filled',
    glyph: 'M7.4 9.4V8a2.6 2.6 0 0 1 5.2 0v1.4M6.6 9.4h6.8v4.8H6.6z',
    fill: 'var(--ih-lock-bg)',
  },
  none: { label: '', tone: 'neutral', circle: 'none', glyph: null, fill: 'var(--ih-accent-soft)' },
};

export function stageStyle(state: DisplayState): StageStyle {
  return STYLES[state];
}

export const TONE_COLOR: Record<StageTone, string> = {
  ok: 'var(--ih-ok-fg)',
  warn: 'var(--ih-warn-fg)',
  accent: 'var(--ih-accent)',
  alert: 'var(--ih-alert-fg)',
  skip: 'var(--ih-skip-fg)',
  lock: 'var(--ih-lock-fg)',
  neutral: 'var(--ih-border-strong)',
};

/** Section colours by order (handoff §0.6): a section keeps its colour on every tab. */
export const SECTION_TONES: readonly StageTone[] = ['accent', 'ok', 'skip', 'warn', 'lock'];

export function sectionTone(index: number): StageTone {
  const n = SECTION_TONES.length;
  return SECTION_TONES[((index % n) + n) % n]!;
}
