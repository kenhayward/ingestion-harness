import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReprocessDialog } from '../src/ui/ReprocessDialog.js';
import { MODEL_CHOICES } from './fake-api.js';

describe('ReprocessDialog', () => {
  it('says what will run, offers the model choices and runs with the one picked', async () => {
    const onConfirm = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <ReprocessDialog
        title="Re-process a.pdf"
        confirmLabel="Re-process"
        choices={MODEL_CHOICES}
        initialModel=""
        emptyLabel="Document type's models"
        onConfirm={onConfirm}
        onClose={onClose}
        summary={<p>Earlier review edits are discarded.</p>}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Re-process a.pdf' });
    expect(dialog).toHaveTextContent('Earlier review edits are discarded.');
    const model = screen.getByRole('combobox', { name: 'Model' });
    expect(model).toHaveFocus();
    await userEvent.selectOptions(model, 'New for testing only');
    await userEvent.click(screen.getByRole('button', { name: 'Re-process' }));
    expect(onConfirm).toHaveBeenCalledWith('test');
    expect(onClose).toHaveBeenCalled();
  });

  it("sends null for the empty option (the document type's models)", async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(
      <ReprocessDialog
        title="Retry a.pdf"
        confirmLabel="Retry"
        choices={MODEL_CHOICES}
        initialModel="test"
        emptyLabel="Document type's models"
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('test');
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Model' }),
      "Document type's models",
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it('shows a fixed model instead of the picker', async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(
      <ReprocessDialog
        title="Run references"
        confirmLabel="Run"
        choices={MODEL_CHOICES}
        fixedModel="The drafting model"
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
    expect(screen.getByText('The drafting model')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it('keeps the dialog open with the reason when the run is refused', async () => {
    const onClose = vi.fn();
    render(
      <ReprocessDialog
        title="Retry a.pdf"
        confirmLabel="Retry"
        choices={MODEL_CHOICES}
        onConfirm={async () => {
          throw new Error('unknown model choice nope');
        }}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unknown model choice nope');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('disables external choices for a local-only project and cancels without running', async () => {
    const onConfirm = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <ReprocessDialog
        title="Evaluate"
        confirmLabel="Evaluate"
        choices={MODEL_CHOICES}
        dataPolicy="local"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    expect(
      (screen.getByRole('option', { name: /Cloud model/ }) as HTMLOptionElement).disabled,
    ).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
