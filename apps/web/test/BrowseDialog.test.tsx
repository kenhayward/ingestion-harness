import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { BrowseDialog } from '../src/access/BrowseDialog.js';
import { fakeApi } from './fake-api.js';

const node = (id: string, over: object = {}) => ({
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
  kind: 'space',
  hasChildren: false,
  selectable: true,
  ...over,
});

function open(browseSink: ReturnType<typeof vi.fn>) {
  const api = fakeApi({ browseSink } as never);
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <BrowseDialog
      api={api}
      sinkId="fake"
      instanceId="sandbox"
      connectionId={null}
      field="space"
      label="Space"
      onPick={onPick}
      onClose={onClose}
    />,
  );
  return { api, onPick, onClose, dialog: screen.getByRole('dialog', { name: 'Choose space' }) };
}

describe('BrowseDialog', () => {
  it('loads one level, opens a node, pages with More, and picks only a selectable node', async () => {
    const browseSink = vi.fn(async (req: { parentId: string | null; cursor: string | null }) => {
      if (req.parentId === 'archive') return { nodes: [node('archive/2026')], nextCursor: null };
      if (req.cursor === 'p2') return { nodes: [node('later')], nextCursor: null };
      return {
        nodes: [node('reports'), node('archive', { hasChildren: true, selectable: false })],
        nextCursor: 'p2',
      };
    });
    const { onPick, onClose, dialog } = open(browseSink);
    expect(await within(dialog).findByText('Reports')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Use Archive' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open Archive' }));
    expect(await within(dialog).findByText('Archive/2026')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'More' }));
    expect(await within(dialog).findByText('Later')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Use Reports' }));
    expect(onPick).toHaveBeenCalledWith('reports', 'Reports');
    expect(onClose).toHaveBeenCalled();
  });

  it('a label with markup is text', async () => {
    const browseSink = vi.fn(async () => ({
      nodes: [node('x', { label: '<img src=x onerror=alert(1)>' })],
      nextCursor: null,
    }));
    const { dialog } = open(browseSink);
    expect(await within(dialog).findByText('<img src=x onerror=alert(1)>')).toBeVisible();
    expect(dialog.querySelector('img')).toBeNull();
  });

  it('without a connection, says to add one and offers Manage connections', async () => {
    const browseSink = vi.fn(async () => {
      throw new ApiError('Ada has no connection for sandbox: add one on the connections page', 422);
    });
    const { api, dialog } = open(browseSink);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(
      'Ada has no connection for sandbox: add one on the connections page',
    );
    expect(alert).not.toHaveTextContent('Add your connection');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Manage connections' }));
    expect(api.openConnections).toHaveBeenCalled();
  });

  it('has one Cancel', async () => {
    const { dialog } = open(vi.fn(async () => ({ nodes: [node('reports')], nextCursor: null })));
    await within(dialog).findByRole('button', { name: 'Reports' });
    expect(within(dialog).getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
  });

  it('a flat list loads every page, filters as you type, and picks on a click', async () => {
    const browseSink = vi.fn(async (req: { cursor: string | null }) =>
      req.cursor === 'p2'
        ? { nodes: [node('quality', { label: 'Quality records (Rep-3)' })], nextCursor: null }
        : {
            nodes: [
              node('training', { label: 'Training (Rep-1)' }),
              node('stability', { label: 'Stability studies (Rep-2)' }),
            ],
            nextCursor: 'p2',
          },
    );
    const { onPick, onClose, dialog } = open(browseSink);
    expect(
      await within(dialog).findByRole('button', { name: 'Quality records (Rep-3)' }),
    ).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'More' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /^Use / })).toBeNull();
    await userEvent.type(within(dialog).getByRole('searchbox', { name: 'Filter space' }), 'STAB');
    expect(within(dialog).queryByRole('button', { name: 'Training (Rep-1)' })).toBeNull();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Stability studies (Rep-2)' }),
    );
    expect(onPick).toHaveBeenCalledWith('stability', 'Stability studies (Rep-2)');
    expect(onClose).toHaveBeenCalled();
  });

  it('groups leaves under their parents, filters on the leaves only, and picks on a click', async () => {
    const browseSink = vi.fn(async (req: { parentId: string | null }) => {
      if (req.parentId === 'dp-cmc')
        return { nodes: [node('os-1', { label: 'CMC_Integration' })], nextCursor: null };
      if (req.parentId === 'dp-lab')
        return {
          nodes: [node('os-2', { label: 'Lab results' }), node('os-3', { label: 'Lab archive' })],
          nextCursor: null,
        };
      return {
        nodes: [
          node('dp-cmc', { label: 'dp-cmc', hasChildren: true, selectable: false }),
          node('dp-lab', { label: 'dp-lab', hasChildren: true, selectable: false }),
        ],
        nextCursor: null,
      };
    });
    const { onPick, dialog } = open(browseSink);
    const cmc = await within(dialog).findByRole('group', { name: 'dp-cmc' });
    expect(within(cmc).getByRole('button', { name: 'CMC_Integration' })).toBeVisible();
    expect(within(dialog).getByRole('group', { name: 'dp-lab' })).toBeVisible();
    // The filter matches leaves, never a group's own name.
    await userEvent.type(within(dialog).getByRole('searchbox', { name: 'Filter space' }), 'lab');
    expect(within(dialog).queryByRole('group', { name: 'dp-cmc' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Lab results' })).toBeVisible();
    await userEvent.clear(within(dialog).getByRole('searchbox', { name: 'Filter space' }));
    await userEvent.type(within(dialog).getByRole('searchbox', { name: 'Filter space' }), 'dp-');
    expect(within(dialog).getByText('Nothing matches “dp-”.')).toBeVisible();
    await userEvent.clear(within(dialog).getByRole('searchbox', { name: 'Filter space' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lab archive' }));
    expect(onPick).toHaveBeenCalledWith('os-3', 'Lab archive (dp-lab)');
  });

  it('says when the filter matches nothing', async () => {
    const { dialog } = open(vi.fn(async () => ({ nodes: [node('training')], nextCursor: null })));
    await within(dialog).findByRole('button', { name: 'Training' });
    await userEvent.type(within(dialog).getByRole('searchbox', { name: 'Filter space' }), 'zzz');
    expect(within(dialog).getByText('Nothing matches “zzz”.')).toBeVisible();
  });
});
