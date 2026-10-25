import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ITEM_OUTCOMES, type BatchSummary, type Item, type ItemOutcome } from '@ih/shared';
import { App } from '../src/App.js';
import { ApiError } from '../src/api/client.js';
import { ConversionPage } from '../src/conversion/ConversionPage.js';
import { conversionBatch, conversionItem, fakeApi } from './fake-api.js';

const BATCH_ID = '6f1c2a10-4b7e-4c55-9d2a-0c8e7b3f5a11';
const NEW_BATCH_ID = '7a2d3b21-5c8f-4d66-8e3b-1d9f8c4a6b22';
const STARTED = { state: 'started' as const, startedAt: '2026-10-25T10:01:00.000Z' };
const TARGETS = [{ id: 'documents', label: 'Controlled documents', sinkName: 'Document sink' }];

const item = (sourceKey: string, outcome: ItemOutcome, o: Partial<Item> = {}) =>
  conversionItem({ sourceKey, filename: sourceKey.split('/').pop()!, outcome, ...o });

const detailOf = (items: Item[]) => ({
  batch: conversionBatch({ id: BATCH_ID, ...STARTED }),
  items,
});

/** The API with a started batch holding `items` (each read of the batch answers them). */
function batchApi(items: Item[], overrides: Parameters<typeof fakeApi>[0] = {}) {
  return fakeApi({
    listConversionTargets: vi.fn(async () => TARGETS),
    getConversionBatch: vi.fn(async () => detailOf(items)),
    ...overrides,
  });
}

const view = (api: ReturnType<typeof fakeApi>) =>
  render(<ConversionPage api={api} batchId={BATCH_ID} />);

const rowOf = (sourceKey: string) => screen.getByText(sourceKey).closest('tr')!;
const listedKeys = () =>
  within(screen.getByRole('table', { name: 'Documents' }))
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.querySelector('.mono')?.textContent);

function summary(o: Partial<BatchSummary>, counts: Partial<Record<ItemOutcome, number>> = {}) {
  const all = Object.fromEntries(ITEM_OUTCOMES.map((k) => [k, counts[k] ?? 0])) as Record<
    ItemOutcome,
    number
  >;
  const itemCount = Object.values(all).reduce((a, b) => a + b, 0);
  return { ...conversionBatch({ ...STARTED, ...o }), itemCount, counts: all };
}

describe('the Conversion tab: the batch view', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('shows one row per document with its outcome', async () => {
    const api = batchApi([
      item('reports/a.docx', 'created'),
      item('reports/b.docx', 'failed', { detail: 'the file is not a Word document' }),
      item('c.docx', 'changed_in_target', { detail: '2 components changed in the target' }),
      item('d.docx', 'read_back_mismatch'),
    ]);
    view(api);
    await screen.findByText('reports/a.docx');
    expect(listedKeys()).toEqual(['reports/a.docx', 'reports/b.docx', 'c.docx', 'd.docx']);
    expect(within(rowOf('reports/a.docx')).getByText('Created')).toHaveClass('pill');
    expect(within(rowOf('reports/b.docx')).getByText('Failed')).toHaveClass('pill', 'tone-danger');
    expect(rowOf('reports/b.docx')).toHaveTextContent('the file is not a Word document');
    expect(within(rowOf('c.docx')).getByText('Changed in target')).toHaveClass('pill');
    expect(rowOf('c.docx')).toHaveTextContent('2 components changed in the target');
    expect(within(rowOf('d.docx')).getByText('Read-back mismatch')).toHaveClass('pill');
    expect(api.getConversionBatch).toHaveBeenCalledWith(BATCH_ID);
  });

  it('rows update as items settle', async () => {
    vi.useFakeTimers();
    try {
      const a = item('a.docx', 'queued');
      const b = item('b.docx', 'decomposing');
      const getConversionBatch = vi
        .fn()
        .mockResolvedValueOnce(detailOf([a, b]))
        .mockResolvedValueOnce(detailOf([{ ...a, outcome: 'delivering' }, b]))
        .mockResolvedValue(
          detailOf([
            { ...a, outcome: 'created' },
            { ...b, outcome: 'already_loaded' },
          ]),
        );
      const page = view(batchApi([], { getConversionBatch }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(within(rowOf('a.docx')).getByText('Queued')).toBeInTheDocument();
      expect(within(rowOf('b.docx')).getByText('Decomposing')).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(2999));
      expect(getConversionBatch).toHaveBeenCalledTimes(1); // every 3 s, not sooner
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(within(rowOf('a.docx')).getByText('Delivering')).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(within(rowOf('a.docx')).getByText('Created')).toBeInTheDocument();
      expect(within(rowOf('b.docx')).getByText('Already loaded')).toBeInTheDocument();
      expect(getConversionBatch).toHaveBeenCalledTimes(3);
      // Nothing is unfinished: it stops.
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(getConversionBatch).toHaveBeenCalledTimes(3);
      page.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops refreshing when the page is left', async () => {
    vi.useFakeTimers();
    try {
      const getConversionBatch = vi.fn(async () => detailOf([item('a.docx', 'queued')]));
      const page = view(batchApi([], { getConversionBatch }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      page.unmount();
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(getConversionBatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters to needs attention', async () => {
    view(
      batchApi([
        item('created.docx', 'created'),
        item('duplicate.docx', 'duplicate'),
        item('changed.docx', 'changed_in_target'),
        item('mismatch.docx', 'read_back_mismatch'),
        item('unresolved.docx', 'unresolved'),
        item('failed.docx', 'failed'),
        item('loaded.docx', 'already_loaded'),
        item('queued.docx', 'queued'),
      ]),
    );
    await screen.findByText('created.docx');
    const filter = within(screen.getByRole('group', { name: 'Show' }));
    expect(filter.getByRole('button', { name: /^Needs attention/ })).toHaveTextContent('5');
    await userEvent.click(filter.getByRole('button', { name: /^Needs attention/ }));
    expect(listedKeys()).toEqual([
      'duplicate.docx',
      'changed.docx',
      'mismatch.docx',
      'unresolved.docx',
      'failed.docx',
    ]);
    await userEvent.click(filter.getByRole('button', { name: /^Done/ }));
    expect(listedKeys()).toEqual(['created.docx', 'loaded.docx']);
    await userEvent.click(filter.getByRole('button', { name: /^All/ }));
    expect(listedKeys()).toHaveLength(8);
  });

  it('links a delivered document to the target', async () => {
    view(
      batchApi([
        item('a.docx', 'created', { link: 'https://target.example.com/documents/D-42' }),
        item('b.docx', 'failed'),
      ]),
    );
    await screen.findByText('a.docx');
    const link = within(rowOf('a.docx')).getByRole('link', { name: 'Open in the target' });
    expect(link).toHaveAttribute('href', 'https://target.example.com/documents/D-42');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(within(rowOf('b.docx')).queryByRole('link')).toBeNull();
  });

  it("opens an item's report", async () => {
    const a = item('a.docx', 'created', { reportKey: 'decomposition/x/a/report.json' });
    const api = batchApi([a], {
      getConversionReport: vi.fn(async () => ({
        flags: [
          { code: 'heading_empty', severity: 'warning', at: 's-3', message: 'empty heading' },
          { code: 'changes_accepted', severity: 'info', message: '4 tracked changes accepted' },
        ],
      })),
    });
    view(api);
    await screen.findByText('a.docx');
    await userEvent.click(within(rowOf('a.docx')).getByRole('button', { name: 'Report' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Report: a.docx' }));
    expect(api.getConversionReport).toHaveBeenCalledWith(a.id);
    expect(await dialog.findByText('empty heading')).toBeInTheDocument();
    expect(dialog.getByText('empty heading').closest('li')).toHaveTextContent('Warning');
    expect(dialog.getByText('empty heading').closest('li')).toHaveTextContent('s-3');
    expect(dialog.getByText('4 tracked changes accepted').closest('li')).toHaveTextContent('Info');
  });

  it('says when there is no report yet', async () => {
    view(
      batchApi([item('a.docx', 'decomposing')], {
        getConversionReport: vi.fn(async () => {
          throw new ApiError('no report', 404);
        }),
      }),
    );
    await screen.findByText('a.docx');
    await userEvent.click(within(rowOf('a.docx')).getByRole('button', { name: 'Report' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Report: a.docx' }));
    expect(await dialog.findByText(/No report yet/)).toBeInTheDocument();
  });

  it('offers force-load on already loaded', async () => {
    const loaded = item('loaded.docx', 'already_loaded', { registerEntryId: crypto.randomUUID() });
    const duplicate = item('duplicate.docx', 'duplicate');
    const created = item('created.docx', 'created', { registerEntryId: crypto.randomUUID() });
    const api = batchApi([loaded, duplicate, created], {
      forceConversionItem: vi.fn(async () => ({
        batch: conversionBatch({ id: NEW_BATCH_ID, ...STARTED, force: true }),
        items: [item('loaded.docx', 'queued', { batchId: NEW_BATCH_ID, redeliverOf: loaded.id })],
      })),
    });
    view(api);
    await screen.findByText('loaded.docx');
    expect(
      within(rowOf('duplicate.docx')).getByRole('button', { name: 'Force-load' }),
    ).toBeVisible();
    expect(within(rowOf('created.docx')).queryByRole('button', { name: 'Force-load' })).toBeNull();
    await userEvent.click(within(rowOf('loaded.docx')).getByRole('button', { name: 'Force-load' }));
    expect(api.forceConversionItem).toHaveBeenCalledWith(loaded.id);
    const notice = await screen.findByRole('status', { name: 'Action' });
    expect(within(notice).getByRole('link', { name: 'Open the new batch' })).toHaveAttribute(
      'href',
      `#/conversion/${NEW_BATCH_ID}`,
    );
    await waitFor(() => expect(api.getConversionBatch).toHaveBeenCalledTimes(2));
  });

  it('offers redeliver on a delivered or refused item, with an optional file', async () => {
    const created = item('created.docx', 'created', { registerEntryId: crypto.randomUUID() });
    const changed = item('changed.docx', 'changed_in_target', {
      registerEntryId: crypto.randomUUID(),
    });
    const api = batchApi(
      [
        created,
        changed,
        item('failed.docx', 'failed'),
        item('queued.docx', 'queued'),
        item('duplicate.docx', 'duplicate'),
      ],
      {
        redeliverConversionItem: vi.fn(async () => ({
          batch: conversionBatch({ id: NEW_BATCH_ID, ...STARTED, force: true }),
          items: [item('created.docx', 'queued', { batchId: NEW_BATCH_ID })],
        })),
      },
    );
    view(api);
    await screen.findByText('created.docx');
    expect(within(rowOf('changed.docx')).getByRole('button', { name: 'Redeliver' })).toBeVisible();
    for (const key of ['failed.docx', 'queued.docx', 'duplicate.docx']) {
      expect(within(rowOf(key)).queryByRole('button', { name: 'Redeliver' })).toBeNull();
    }
    await userEvent.click(within(rowOf('created.docx')).getByRole('button', { name: 'Redeliver' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Redeliver created.docx' }));
    const replacement = new File(['PK'], 'created-v2.docx');
    await userEvent.upload(dialog.getByLabelText(/Replacement file/), replacement);
    await userEvent.click(dialog.getByRole('button', { name: 'Redeliver' }));
    expect(api.redeliverConversionItem).toHaveBeenCalledWith(created.id, replacement);
    expect(await screen.findByRole('link', { name: 'Open the new batch' })).toHaveAttribute(
      'href',
      `#/conversion/${NEW_BATCH_ID}`,
    );
  });

  it('detach asks to confirm', async () => {
    const changed = item('changed.docx', 'changed_in_target', {
      registerEntryId: crypto.randomUUID(),
      detail: '2 components changed in the target',
    });
    const detached = {
      ...changed,
      detail: 'detached from document D-7: the next run of this source creates a new document',
    };
    const getConversionBatch = vi
      .fn()
      .mockResolvedValueOnce(detailOf([changed]))
      .mockResolvedValue(detailOf([detached]));
    const api = batchApi([], {
      getConversionBatch,
      detachConversionItem: vi.fn(async () => detached),
    });
    view(api);
    await screen.findByText('changed.docx');
    await userEvent.click(within(rowOf('changed.docx')).getByRole('button', { name: 'Detach' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Detach changed.docx?' }));
    expect(dialog.getByText(/stays in the target, untouched/)).toBeInTheDocument();
    expect(api.detachConversionItem).not.toHaveBeenCalled();
    await userEvent.click(dialog.getByRole('button', { name: 'Detach' }));
    expect(api.detachConversionItem).toHaveBeenCalledWith(changed.id);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      await within(rowOf('changed.docx')).findByText(/detached from document D-7/),
    ).toBeVisible();
    // Done with: still changed in the target, but neither action is offered again (M7).
    const row = within(rowOf('changed.docx'));
    expect(row.getByText('Changed in target')).toBeInTheDocument();
    expect(row.queryByRole('button', { name: 'Detach' })).toBeNull();
    expect(row.queryByRole('button', { name: "Accept the target's state" })).toBeNull();
    expect(row.queryByRole('button', { name: 'Redeliver' })).toBeNull();
  });

  it('accept shows each changed component and needs the checkbox', async () => {
    const changed = item('changed.docx', 'changed_in_target', {
      registerEntryId: crypto.randomUUID(),
    });
    const accepted = {
      ...changed,
      detail:
        "the target's state was accepted: the next run of this source updates document D-7, " +
        'overwriting the edits made in the target',
    };
    const getConversionBatch = vi
      .fn()
      .mockResolvedValueOnce(detailOf([changed]))
      .mockResolvedValue(detailOf([accepted]));
    const api = batchApi([], {
      getConversionBatch,
      previewAccept: vi.fn(async () => ({
        changed: [
          { id: 'section-1', expected: '3', actual: '5' },
          { id: 'table-2', expected: '1', actual: null },
        ],
        acceptable: true,
        updatedAt: '2026-10-25T11:00:00.000Z',
      })),
      acceptTargetState: vi.fn(async () => ({ item: accepted, changed: [] })),
    });
    view(api);
    await screen.findByText('changed.docx');
    await userEvent.click(
      within(rowOf('changed.docx')).getByRole('button', { name: "Accept the target's state" }),
    );
    const dialog = within(await screen.findByRole('dialog', { name: "Accept the target's state" }));
    expect(api.previewAccept).toHaveBeenCalledWith(changed.id);
    expect(dialog.getByText(/the edits made in the target will be overwritten/i)).toBeVisible();
    const components = within(await dialog.findByRole('table', { name: 'Changed components' }));
    const section = components.getByText('section-1').closest('tr')!;
    expect(
      within(section)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['section-1', '3', '5']);
    expect(components.getByText('table-2').closest('tr')).toHaveTextContent(
      'removed in the target',
    );
    const confirm = dialog.getByRole('button', { name: 'Accept and overwrite' });
    expect(confirm).toBeDisabled();
    await userEvent.click(
      dialog.getByRole('checkbox', {
        name: 'I understand the edits in the target will be overwritten',
      }),
    );
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(api.acceptTargetState).toHaveBeenCalledWith(changed.id, '2026-10-25T11:00:00.000Z');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const row = within(rowOf('changed.docx'));
    expect(row.getByText(/the target's state was accepted/)).toBeVisible();
    expect(row.queryByRole('button', { name: "Accept the target's state" })).toBeNull();
    expect(row.queryByRole('button', { name: 'Detach' })).toBeNull();
    // The accepted state goes in on the next run: redeliver stays on offer.
    expect(row.getByRole('button', { name: 'Redeliver' })).toBeVisible();
  });

  it('a stale preview shows the new changes', async () => {
    const changed = item('changed.docx', 'changed_in_target', {
      registerEntryId: crypto.randomUUID(),
    });
    const previewAccept = vi
      .fn()
      .mockResolvedValueOnce({
        changed: [{ id: 'section-1', expected: '3', actual: '5' }],
        acceptable: true,
        updatedAt: 'T1',
      })
      .mockResolvedValue({
        changed: [{ id: 'section-1', expected: '3', actual: '6' }],
        acceptable: true,
        updatedAt: 'T2',
      });
    const api = batchApi([changed], {
      previewAccept,
      acceptTargetState: vi.fn(async () => {
        throw new ApiError('the document changed since the preview', 409, {
          code: 'stale_preview',
        });
      }),
    });
    view(api);
    await screen.findByText('changed.docx');
    await userEvent.click(
      within(rowOf('changed.docx')).getByRole('button', { name: "Accept the target's state" }),
    );
    const dialog = within(await screen.findByRole('dialog', { name: "Accept the target's state" }));
    await dialog.findByText('section-1');
    const box = dialog.getByRole('checkbox', {
      name: 'I understand the edits in the target will be overwritten',
    });
    await userEvent.click(box);
    await userEvent.click(dialog.getByRole('button', { name: 'Accept and overwrite' }));
    expect(
      await dialog.findByText(
        'This document changed again since you opened this; review the new changes',
      ),
    ).toBeVisible();
    await waitFor(() => expect(previewAccept).toHaveBeenCalledTimes(2));
    expect(await dialog.findByText('6')).toBeInTheDocument();
    expect(box).not.toBeChecked();
    expect(dialog.getByRole('button', { name: 'Accept and overwrite' })).toBeDisabled();
  });

  it('accept is unavailable when too many changed', async () => {
    const changed = item('changed.docx', 'changed_in_target', {
      registerEntryId: crypto.randomUUID(),
    });
    const api = batchApi([changed], {
      previewAccept: vi.fn(async () => ({
        changed: [{ id: 'section-1', expected: '3', actual: '5' }],
        acceptable: false,
        reason: 'too many changes to accept here; detach instead',
        updatedAt: 'T1',
      })),
    });
    view(api);
    await screen.findByText('changed.docx');
    await userEvent.click(
      within(rowOf('changed.docx')).getByRole('button', { name: "Accept the target's state" }),
    );
    const dialog = within(await screen.findByRole('dialog', { name: "Accept the target's state" }));
    expect(
      await dialog.findByText(/too many changes to accept here; detach instead/),
    ).toBeVisible();
    expect(dialog.queryByRole('button', { name: 'Accept and overwrite' })).toBeNull();
    expect(dialog.queryByRole('checkbox')).toBeNull();
    await userEvent.click(dialog.getByRole('button', { name: 'Detach instead' }));
    expect(await screen.findByRole('dialog', { name: 'Detach changed.docx?' })).toBeVisible();
    expect(api.acceptTargetState).not.toHaveBeenCalled();
  });

  it('resumes an open batch after reload', async () => {
    window.location.hash = `#/conversion/${BATCH_ID}`;
    const api = batchApi([item('a.docx', 'created'), item('b.docx', 'failed')]);
    render(<App api={api} pollMs={0} />);
    expect(await screen.findByText('a.docx')).toBeInTheDocument();
    expect(listedKeys()).toEqual(['a.docx', 'b.docx']);
    expect(api.getConversionBatch).toHaveBeenCalledWith(BATCH_ID);
  });

  it('an unstarted batch says so and can be discarded', async () => {
    const api = batchApi([], {
      getConversionBatch: vi.fn(async () => ({
        batch: conversionBatch({ id: BATCH_ID }),
        items: [item('a.docx', 'queued')],
      })),
      discardConversionBatch: vi.fn(async () => undefined),
    });
    view(api);
    expect(await screen.findByText(/was never started/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Discard the batch' }));
    expect(api.discardConversionBatch).toHaveBeenCalledWith(BATCH_ID);
    await waitFor(() => expect(window.location.hash).toBe('#/conversion'));
  });

  it('says when there is no such batch', async () => {
    view(
      batchApi([], {
        getConversionBatch: vi.fn(async () => {
          throw new ApiError('not found', 404);
        }),
      }),
    );
    expect(await screen.findByText(/No such batch/)).toBeVisible();
  });

  it('earlier batches newest first', async () => {
    const older = summary(
      { id: '11111111-1111-4111-8111-111111111111', createdAt: '2026-10-24T09:00:00.000Z' },
      { created: 2, failed: 1 },
    );
    const newer = summary(
      { id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-10-25T09:00:00.000Z' },
      { queued: 1, changed_in_target: 1 },
    );
    const api = fakeApi({
      listConversionTargets: vi.fn(async () => TARGETS),
      listConversionBatches: vi.fn(async () => [older, newer]),
    });
    render(<ConversionPage api={api} />);
    const list = within(await screen.findByRole('list', { name: 'Earlier batches' }));
    await waitFor(() => expect(list.getAllByRole('listitem')).toHaveLength(2));
    const links = list.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      `#/conversion/${newer.id}`,
      `#/conversion/${older.id}`,
    ]);
    const [first, second] = list.getAllByRole('listitem');
    expect(first).toHaveTextContent('Controlled documents');
    expect(first).toHaveTextContent('2 documents');
    expect(first).toHaveTextContent('1 queued');
    expect(first).toHaveTextContent('1 changed in target');
    expect(second).toHaveTextContent('2 created');
    expect(second).toHaveTextContent('1 failed');
  });
});
