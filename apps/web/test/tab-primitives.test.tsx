import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Meter } from '../src/ui/Meter.js';
import { SECTION_TONES, sectionTone } from '../src/ui/stageStyle.js';
import { StaleBanner } from '../src/workbench/StaleBanner.js';
import { SampleTag, SectionChip } from '../src/workbench/tags.js';

describe('sectionTone', () => {
  it.each([
    [0, 'accent'],
    [1, 'ok'],
    [2, 'skip'],
    [3, 'warn'],
    [4, 'lock'],
    [5, 'accent'],
    [7, 'skip'],
  ] as const)('section %i is %s', (index, tone) => {
    expect(sectionTone(index)).toBe(tone);
  });

  it('cycles five tones', () => {
    expect(SECTION_TONES).toHaveLength(5);
  });
});

describe('SectionChip', () => {
  it('shows the id with a dot in the section colour', () => {
    const { container } = render(<SectionChip id="payment" index={4} />);
    expect(screen.getByText('payment')).toBeInTheDocument();
    expect((container.querySelector('.section-dot') as HTMLElement).style.background).toBe(
      'var(--ih-lock-fg)',
    );
  });

  it('says when the section is not in the draft', () => {
    render(<SectionChip id="ghost" index={-1} />);
    expect(screen.getByText('(not a section of the draft)')).toBeInTheDocument();
  });
});

describe('SampleTag', () => {
  it.each([
    ['dev', 'DEV', 'tone-info'],
    ['holdout', 'HOLDOUT', 'tone-skip'],
  ] as const)('%s reads %s in %s', (role, text, tone) => {
    render(<SampleTag role={role} />);
    expect(screen.getByText(text)).toHaveClass('sample-tag', tone);
  });
});

describe('Meter', () => {
  it('carries the numbers in its label and places fill and threshold on the scale', () => {
    render(<Meter label="Holdout" value={0.88} threshold={0.9} min={0.7} max={1} tone="skip" />);
    const meter = screen.getByRole('img', { name: 'Holdout: 88%, threshold 90%' });
    expect((meter.querySelector('.meter-fill') as HTMLElement).style.width).toBe('60%');
    expect((meter.querySelector('.meter-tick') as HTMLElement).style.left).toBe('66.67%');
  });

  it('has no fill without a value', () => {
    render(<Meter label="Dev" value={null} />);
    const meter = screen.getByRole('img', { name: 'Dev: no score yet' });
    expect(meter.querySelector('.meter-fill')).toBeNull();
    expect(meter.querySelector('.meter-tick')).toBeNull();
  });

  it('can draw the threshold tick on an empty track', () => {
    render(<Meter label="Dev" value={null} threshold={0.9} min={0.7} showTickWithoutValue />);
    const meter = screen.getByRole('img', { name: 'Dev: no score yet' });
    expect(meter.querySelector('.meter-fill')).toBeNull();
    expect((meter.querySelector('.meter-tick') as HTMLElement).style.left).toBe('66.67%');
  });

  it('clamps values outside the scale', () => {
    render(<Meter label="Dev" value={1.2} />);
    const meter = screen.getByRole('img', { name: 'Dev: 120%' });
    expect((meter.querySelector('.meter-fill') as HTMLElement).style.width).toBe('100%');
  });
});

describe('Meter degenerate scales', () => {
  it.each([
    ['max equals min', { value: 0.5, min: 0.5, max: 0.5 }],
    ['max below min', { value: 0.5, min: 1, max: 0 }],
  ])('draws a 0%% fill when %s', (_name, props) => {
    const { container } = render(<Meter label="Dev" {...props} />);
    expect((container.querySelector('.meter-fill') as HTMLElement).style.width).toBe('0%');
  });
});

describe('Meter non-finite values', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('treats %s as no score yet', (_name, value) => {
    render(<Meter label="Dev" value={value} threshold={0.9} />);
    const meter = screen.getByRole('img', { name: 'Dev: no score yet' });
    expect(meter.querySelector('.meter-fill')).toBeNull();
    expect(meter.querySelector('.meter-tick')).toBeNull();
  });
});

describe('StaleBanner', () => {
  it('names what changed, with Keep and Propose again', async () => {
    const onKeep = vi.fn();
    const onPropose = vi.fn();
    render(
      <StaleBanner onKeep={onKeep} onPropose={onPropose}>
        Survey changed after these anchors were accepted.
      </StaleBanner>,
    );
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Survey changed after these anchors were accepted.');
    expect(within(note).getByRole('img', { name: 'Stale' })).toBeInTheDocument();
    await userEvent.click(within(note).getByRole('button', { name: 'Keep' }));
    expect(onKeep).toHaveBeenCalled();
    await userEvent.click(within(note).getByRole('button', { name: 'Propose again' }));
    expect(onPropose).toHaveBeenCalled();
  });

  it('leaves out the buttons it has no handler for', () => {
    render(<StaleBanner>Brief changed.</StaleBanner>);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('disables its buttons while busy', () => {
    render(
      <StaleBanner onKeep={vi.fn()} onPropose={vi.fn()} busy>
        Brief changed.
      </StaleBanner>,
    );
    expect(screen.getByRole('button', { name: 'Keep' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Propose again' })).toBeDisabled();
  });

  it('is an info note without the stale icon', () => {
    render(<StaleBanner tone="info">This proposal used brief v2.</StaleBanner>);
    const note = screen.getByRole('note');
    expect(note).toHaveAttribute('data-tone', 'info');
    expect(within(note).queryByRole('img')).toBeNull();
  });

  it('names its Keep button and has a skip tone', async () => {
    const onKeep = vi.fn();
    render(
      <StaleBanner tone="skip" onKeep={onKeep} keepLabel="Keep these anchors">
        Skipped
      </StaleBanner>,
    );
    const note = screen.getByRole('note');
    expect(note).toHaveAttribute('data-tone', 'skip');
    await userEvent.click(screen.getByRole('button', { name: 'Keep these anchors' }));
    expect(onKeep).toHaveBeenCalled();
  });
  it('has a warn tone without the stale icon', () => {
    render(<StaleBanner tone="warn">Steps has an open proposal.</StaleBanner>);
    const note = screen.getByRole('note');
    expect(note).toHaveAttribute('data-tone', 'warn');
    expect(within(note).queryByRole('img', { name: 'Stale' })).toBeNull();
    cleanup();
    render(<StaleBanner>Default tone.</StaleBanner>);
    expect(
      within(screen.getByRole('note')).getByRole('img', { name: 'Stale' }),
    ).toBeInTheDocument();
  });
});
