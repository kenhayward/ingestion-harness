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
    expect(onPick).toHaveBeenCalledWith('reports');
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
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Add your connection for sandbox first',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Manage connections' }));
    expect(api.openConnections).toHaveBeenCalled();
  });
});
