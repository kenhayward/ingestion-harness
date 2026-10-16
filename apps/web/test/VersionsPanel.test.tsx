import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TemplateVersionItem } from '../src/api/client.js';
import { VersionsPanel } from '../src/templates/VersionsPanel.js';
import { fakeApi, templateView } from './fake-api.js';

const item = (overrides: Partial<TemplateVersionItem> = {}): TemplateVersionItem => ({
  version: 1,
  status: 'published',
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  publishedAt: '2026-10-01T09:00:00.000Z',
  label: null,
  note: null,
  labelSetBy: null,
  labelSetAt: null,
  ...overrides,
});

const withDraft = [
  item({ version: 3, status: 'draft', publishedAt: null, updatedAt: '2026-10-03T00:00:00.000Z' }),
  item({ version: 2, label: 'Two-page letters', note: 'Signed off', labelSetBy: 'Ken' }),
  item({ version: 1 }),
];

function setup(
  versions: TemplateVersionItem[],
  props: Partial<Parameters<typeof VersionsPanel>[0]> = {},
) {
  const api = fakeApi({ listVersions: vi.fn(async () => versions) });
  const onRestored = vi.fn();
  const onStarted = vi.fn();
  render(
    <VersionsPanel
      api={api}
      templateId="letter"
      openVersion={3}
      openUpdatedAt="2026-10-03T00:00:00.000Z"
      dirty={false}
      retired={null}
      refreshKey={0}
      onRestored={onRestored}
      onStarted={onStarted}
      {...props}
    />,
  );
  return { api, onRestored, onStarted };
}

describe('VersionsPanel (#144)', () => {
  it('lists the versions newest first with their labels and notes', async () => {
    setup(withDraft);
    const list = await screen.findByRole('list', { name: 'Versions' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'v3 · Draft',
      'v2 · Published · Two-page letters',
      'v1 · Published',
    ]);
    expect(rows[1]).toHaveTextContent('Signed off');
    expect(rows[1]).toHaveTextContent('Ken');
    expect(within(rows[0]!).getByText('Open in the editor')).toBeInTheDocument();
    expect(within(rows[2]!).getByRole('link', { name: 'Open v1' })).toHaveAttribute(
      'href',
      '#/templates/letter/1',
    );
  });

  it('edits a label and note, and clears a label left blank', async () => {
    const { api } = setup(withDraft);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit label of v1' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Label' }), '  First cut ');
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Single pages');
    await userEvent.click(screen.getByRole('button', { name: 'Save label' }));
    expect(api.setVersionLabel).toHaveBeenCalledWith('letter', 1, {
      label: 'First cut',
      note: 'Single pages',
    });
    await waitFor(() => expect(api.listVersions).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole('button', { name: 'Edit label of v2' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Label' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save label' }));
    expect(api.setVersionLabel).toHaveBeenLastCalledWith('letter', 2, {
      label: null,
      note: 'Signed off',
    });
  });

  it('replaces the open draft with an earlier version after a confirm', async () => {
    const { api, onRestored } = setup(withDraft);
    await userEvent.click(await screen.findByRole('button', { name: 'Replace draft v3 with v2' }));
    const dialog = screen.getByRole('dialog', { name: 'Replace draft v3 with v2?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace draft' }));
    expect(api.restoreVersion).toHaveBeenCalledWith('letter', 3, 2, '2026-10-03T00:00:00.000Z');
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps a refused replace in the dialog', async () => {
    const { api } = setup(withDraft);
    vi.mocked(api.restoreVersion).mockRejectedValueOnce(new Error('the draft changed'));
    await userEvent.click(await screen.findByRole('button', { name: 'Replace draft v3 with v1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Replace draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('the draft changed');
  });

  it('will not replace a draft with unsaved edits', async () => {
    setup(withDraft, { dirty: true });
    const replace = await screen.findByRole('button', { name: 'Replace draft v3 with v2' });
    expect(replace).toBeDisabled();
    expect(replace).toHaveAttribute('title', 'Save or discard your changes first');
  });

  it('starts the next draft from a version when none is open', async () => {
    const versions = [item({ version: 2, label: 'Two-page letters' }), item({ version: 1 })];
    const api = fakeApi({
      listVersions: vi.fn(async () => versions),
      newDraft: vi.fn(async () => templateView({ id: 'letter', version: 3 })),
    });
    const onStarted = vi.fn();
    render(
      <VersionsPanel
        api={api}
        templateId="letter"
        openVersion={2}
        openUpdatedAt={null}
        dirty={false}
        retired={null}
        refreshKey={0}
        onRestored={vi.fn()}
        onStarted={onStarted}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Start v3 from v1' }));
    expect(api.newDraft).toHaveBeenCalledWith('letter', 1);
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Replace draft/ })).not.toBeInTheDocument();
  });

  it('labels a retired type but starts nothing from it', async () => {
    setup(withDraft, { retired: 'Letter is retired' });
    expect(await screen.findByRole('button', { name: 'Edit label of v1' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Replace draft v3 with v1' })).toBeDisabled();
  });
});
