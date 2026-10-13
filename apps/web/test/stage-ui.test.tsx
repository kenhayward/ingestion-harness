import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StageLegend, StageStatusIcon } from '../src/ui/StageStatusIcon.js';
import { stageStyle, TONE_COLOR, type DisplayState } from '../src/ui/stageStyle.js';

const STATES: DisplayState[] = [
  'accepted',
  'ready',
  'proposed',
  'warn',
  'running',
  'stale',
  'skipped',
  'pending',
  'locked',
];

describe('stageStyle', () => {
  it.each([
    ['accepted', 'Accepted', 'ok', 'filled', 'M6 10.5l2.7 2.7L14 7.8', 'var(--ih-ok-bg)'],
    ['ready', 'Ready to publish', 'ok', 'filled', 'M6 10.5l2.7 2.7L14 7.8', 'var(--ih-ok-bg)'],
    ['proposed', 'Needs you', 'warn', 'filled', 'M10 5.6v5.2M10 14.1v.2', 'var(--ih-warn-bg)'],
    ['warn', 'Needs you', 'warn', 'filled', 'M10 5.6v5.2M10 14.1v.2', 'var(--ih-warn-bg)'],
    ['running', 'Running', 'accent', 'track', 'M10 3.6a6.4 6.4 0 1 1-6.4 6.4', 'var(--ih-info-bg)'],
    [
      'stale',
      'Stale',
      'alert',
      'filled',
      'M13.6 8.2a4 4 0 1 0 .3 3.4M14 5v3.3h-3.3',
      'var(--ih-alert-bg)',
    ],
    ['skipped', 'Skipped', 'skip', 'ring', 'M6 10h7M10.4 7l3 3-3 3', 'var(--ih-skip-bg)'],
    ['pending', 'Not started', 'neutral', 'dashed', null, 'var(--ih-surface)'],
    [
      'locked',
      'Locked',
      'lock',
      'filled',
      'M7.4 9.4V8a2.6 2.6 0 0 1 5.2 0v1.4M6.6 9.4h6.8v4.8H6.6z',
      'var(--ih-lock-bg)',
    ],
    ['none', '', 'neutral', 'none', null, 'var(--ih-accent-soft)'],
  ] as const)('%s', (state, label, tone, circle, glyph, fill) => {
    expect(stageStyle(state)).toEqual({ label, tone, circle, glyph, fill });
  });

  it('colours every tone from a token', () => {
    for (const color of Object.values(TONE_COLOR)) expect(color).toMatch(/^var\(--ih-[a-z-]+\)$/);
  });
});

describe('StageStatusIcon', () => {
  it.each(STATES)('labels the %s state', (state) => {
    render(<StageStatusIcon state={state} />);
    expect(screen.getByRole('img', { name: stageStyle(state).label })).toHaveAttribute(
      'data-state',
      state,
    );
  });

  it('takes a fuller label', () => {
    render(<StageStatusIcon state="stale" label="Sections: Stale — outputs changed" />);
    expect(
      screen.getByRole('img', { name: 'Sections: Stale — outputs changed' }),
    ).toBeInTheDocument();
  });

  it('is hidden from assistive tech when decorative', () => {
    const { container } = render(<StageStatusIcon state="accepted" decorative />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws nothing for a tab without a status', () => {
    const { container } = render(<StageStatusIcon state="none" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('fills the circle in the tone and draws the glyph in the surface colour', () => {
    const { container } = render(<StageStatusIcon state="stale" />);
    expect(container.querySelector('circle')!.style.fill).toBe('var(--ih-alert-fg)');
    expect(container.querySelector('path')!.style.stroke).toBe('var(--ih-surface)');
  });

  it('draws a ring glyph in the tone colour and a dashed ring when not started', () => {
    const skipped = render(<StageStatusIcon state="skipped" />).container;
    expect(skipped.querySelector('circle')!.style.fill).toBe('none');
    expect(skipped.querySelector('path')!.style.stroke).toBe('var(--ih-skip-fg)');
    const pending = render(<StageStatusIcon state="pending" />).container;
    expect(pending.querySelector('circle')).toHaveAttribute('stroke-dasharray', '2.6 2.6');
    expect(pending.querySelector('path')).toBeNull();
  });

  it('spins only while running', () => {
    expect(render(<StageStatusIcon state="running" />).container.querySelector('svg')).toHaveClass(
      'spin',
    );
    expect(
      render(<StageStatusIcon state="accepted" />).container.querySelector('svg'),
    ).not.toHaveClass('spin');
  });
});

describe('StageLegend', () => {
  it('names each state once, with decorative icons', () => {
    render(<StageLegend />);
    const legend = screen.getByRole('list', { name: 'Status legend' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Accepted', 'Needs you', 'Running', 'Stale', 'Skipped', 'Locked', 'Not started']);
    expect(within(legend).queryAllByRole('img')).toHaveLength(0);
  });
});
