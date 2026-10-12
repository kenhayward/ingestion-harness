import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Segmented } from '../src/ui/Segmented.js';
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
