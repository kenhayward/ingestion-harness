import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReferencesTab } from '../src/workbench/ReferencesTab.js';
import { fakeApi, job, referenceRow } from './fake-api.js';

function tab(overrides = {}, hasDraft = true) {
  const api = fakeApi(overrides);
  const onChanged = vi.fn();
  render(
    <ReferencesTab
      api={api}
      projectId="letter"
      dataPolicy="local"
      hasDraft={hasDraft}
      pollMs={1}
      onChanged={onChanged}
    />,
  );
  return { api, onChanged };
}

describe('ReferencesTab', () => {
  it('lists each dev sample with its run and reference', async () => {
    tab({
      listReferenceRows: vi.fn(async () => [
        referenceRow({
          filename: 'a.pdf',
          run: { jobId: 'j1', status: 'awaiting_review', error: null, modelOverride: 'draft' },
        }),
        referenceRow({
          filename: 'b.pdf',
          run: null,
          reference: { id: 'r1', name: 'b', createdAt: '' },
        }),
      ]),
    });
    const table = await screen.findByRole('table', { name: 'References' });
    const a = within(table).getByText('a.pdf').closest('tr')!;
    expect(within(a).getByRole('link', { name: 'Verify in Review' })).toHaveAttribute(
      'href',
      '#/review/j1',
    );
    expect(within(a).getByText('Not verified')).toBeInTheDocument();
    const b = within(table).getByText('b.pdf').closest('tr')!;
    expect(within(b).getByText('✓ b')).toBeInTheDocument();
  });

  it('runs the draft model on unverified samples and polls while they run', async () => {
    const listReferenceRows = vi
      .fn()
      .mockResolvedValueOnce([referenceRow({ run: null })])
      .mockResolvedValueOnce([
        referenceRow({
          run: { jobId: 'j1', status: 'running', error: null, modelOverride: 'draft' },
        }),
      ])
      .mockResolvedValue([
        referenceRow({
          run: { jobId: 'j1', status: 'awaiting_review', error: null, modelOverride: 'draft' },
        }),
      ]);
    const { api, onChanged } = tab({
      listReferenceRows,
      proposeReferences: vi.fn(async () => [job()]),
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Run the draft model on unverified samples' }),
    );
    expect(api.proposeReferences).toHaveBeenCalledWith('letter');
    expect(onChanged).toHaveBeenCalled();
    expect(await screen.findByRole('link', { name: 'Verify in Review' })).toBeInTheDocument();
  });

  it('needs an open draft', async () => {
    tab({}, false);
    expect(
      await screen.findByRole('button', { name: 'Run the draft model on unverified samples' }),
    ).toBeDisabled();
  });

  it('skips the stage', async () => {
    const { api, onChanged } = tab({ skipStage: vi.fn(async () => []) });
    await userEvent.click(await screen.findByRole('button', { name: 'Skip this stage' }));
    expect(api.skipStage).toHaveBeenCalledWith('letter', 'references');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
