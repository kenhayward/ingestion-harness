import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Dialog } from '../src/ui/Dialog.js';
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

describe('Dialog', () => {
  function Harness({ onClose = () => {} }: { onClose?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          New document type
        </button>
        {open && (
          <Dialog
            title="New document type"
            onClose={() => {
              onClose();
              setOpen(false);
            }}
          >
            <label>
              Id
              <input />
            </label>
            <button type="button">Create</button>
          </Dialog>
        )}
      </>
    );
  }

  it('is a labelled modal dialog that takes focus', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'New document type' }));
    const dialog = screen.getByRole('dialog', { name: 'New document type' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('Id')).toHaveFocus();
  });

  it('has no description or icon unless given (other dialogs look as before)', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'New document type' }));
    const dialog = screen.getByRole('dialog', { name: 'New document type' });
    expect(dialog).not.toHaveAttribute('aria-describedby');
    expect(within(dialog).getByRole('heading', { name: 'New document type' })).toBeInTheDocument();
  });

  it('shows an icon and a description that describes the dialog', () => {
    render(
      <Dialog
        title="New project"
        icon={<svg data-testid="tile-icon" />}
        description="Drafts a document type."
        onClose={() => {}}
      >
        <input aria-label="Id" />
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    expect(dialog).toHaveAccessibleDescription('Drafts a document type.');
    expect(screen.getByTestId('tile-icon').parentElement).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByLabelText('Id')).toHaveFocus();
  });

  it('closes on Escape and on Cancel, returning focus to the opener', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'New document type' });
    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(opener).toHaveFocus();
  });

  it('keeps Tab inside the dialog', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'New document type' }));
    await userEvent.tab(); // Id -> Create
    await userEvent.tab(); // Create -> Cancel
    await userEvent.tab(); // Cancel -> wraps to Id
    expect(screen.getByLabelText('Id')).toHaveFocus();
    await userEvent.tab({ shift: true }); // Id -> back to Cancel
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });
});
