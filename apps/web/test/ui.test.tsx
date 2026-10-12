import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilterChips } from '../src/ui/FilterChips.js';
import { Segmented } from '../src/ui/Segmented.js';
import { StatusPill } from '../src/ui/StatusPill.js';
import { ThemeSwitch } from '../src/ui/ThemeSwitch.js';

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe('Segmented', () => {
  it('is a labelled group of pressed/unpressed buttons', async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="Fills"
        options={[
          { value: 'fields', label: 'Fields' },
          { value: 'table', label: 'A table' },
        ]}
        value="fields"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('group', { name: 'Fills' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fields' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'A table' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await userEvent.click(screen.getByRole('button', { name: 'A table' }));
    expect(onChange).toHaveBeenCalledWith('table');
  });
});

describe('ThemeSwitch', () => {
  it('defaults to System and switches the document theme', async () => {
    render(<ThemeSwitch />);
    expect(screen.getByRole('group', { name: 'Colour mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem('ih.theme')).toBe('dark');
    await userEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });
});

describe('StatusPill', () => {
  it('always carries the status text', () => {
    render(<StatusPill status="awaiting_review" />);
    expect(screen.getByText('Awaiting review')).toBeInTheDocument();
  });
});

describe('FilterChips', () => {
  it('is a labelled group of pressed chips with counts', async () => {
    const onChange = vi.fn();
    render(
      <FilterChips
        label="Filter jobs by status"
        chips={[
          { value: 'all', label: 'All', count: 8 },
          { value: 'attention', label: 'Needs attention', count: 3, tone: 'warn' },
        ]}
        value="all"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('group', { name: 'Filter jobs by status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All 8' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Needs attention 3' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Needs attention 3' }));
    expect(onChange).toHaveBeenCalledWith('attention');
  });
});
