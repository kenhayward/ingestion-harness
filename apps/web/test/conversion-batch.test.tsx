import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcceptedTargetState, AcceptPreview, BatchDetail } from '@ih/shared';
import { ITEM_OUTCOMES, type BatchSummary, type Item, type ItemOutcome } from '@ih/shared';
import { App } from '../src/App.js';
import { ApiError } from '../src/api/client.js';
import { ConversionPage } from '../src/conversion/ConversionPage.js';
import { spokenDuration } from '../src/conversion/outcomes.js';
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

const documents = () => within(screen.getByRole('table', { name: 'Documents' }));
const rowOf = (sourceKey: string) => documents().getByText(sourceKey).closest('tr')!;
/** Waits for a document's row. */
const findRow = async (sourceKey: string) =>
  (
    await within(await screen.findByRole('table', { name: 'Documents' })).findByText(sourceKey)
  ).closest('tr')!;
/** Picks a document's row: the panel beside the list then shows it, with its actions. */
function panelFor(sourceKey: string) {
  fireEvent.click(documents().getByRole('button', { name: sourceKey }));
  return within(screen.getByRole('complementary', { name: 'Document' }));
}
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
    await findRow('reports/a.docx');
    expect(listedKeys()).toEqual(['reports/a.docx', 'reports/b.docx', 'c.docx', 'd.docx']);
    expect(within(rowOf('reports/a.docx')).getByText('Created')).toHaveClass('pill');
    expect(within(rowOf('reports/b.docx')).getByText('Failed')).toHaveClass('pill', 'tone-danger');
    expect(rowOf('reports/b.docx')).toHaveTextContent('the file is not a Word document');
    expect(within(rowOf('c.docx')).getByText('Changed in target')).toHaveClass('pill');
    expect(rowOf('c.docx')).toHaveTextContent('2 components changed in the target');
    expect(within(rowOf('d.docx')).getByText('Read-back mismatch')).toHaveClass('pill');
    expect(api.getConversionBatch).toHaveBeenCalledWith(BATCH_ID);
  });

  it('says how long each document took, and how long an unfinished one has run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T13:00:40.000Z'));
    try {
      const api = batchApi([
        item('done.docx', 'created', {
          startedAt: '2026-10-26T12:58:00.000Z',
          finishedAt: '2026-10-26T12:59:12.000Z',
        }),
        item('running.docx', 'delivering', { startedAt: '2026-10-26T13:00:00.000Z' }),
        item('queued.docx', 'queued'),
        item('old.docx', 'failed'),
      ]);
      view(api);
      await findRow('done.docx');
      // The row says the time alone; the panel says it in words.
      expect(rowOf('done.docx')).toHaveTextContent('1 min 12 s');
      expect(panelFor('done.docx').getByText(/took 1 min 12 s/)).toBeVisible();
      expect(rowOf('running.docx')).toHaveTextContent('running for 40 s');
      expect(rowOf('queued.docx')).not.toHaveTextContent(/\d+ (s|min)|running for/);
      expect(rowOf('old.docx')).not.toHaveTextContent(/\d+ (s|min)|running for/);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [0, '0 s'],
    [40, '40 s'],
    [72, '1 min 12 s'],
    [120, '2 min'],
    [3725, '1 h 2 min'],
    [7200, '2 h'],
  ])('reads %i seconds as %s', (seconds, said) => {
    expect(spokenDuration(seconds)).toBe(said);
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
    await findRow('created.docx');
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
    await findRow('a.docx');
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
    await findRow('a.docx');
    await userEvent.click(panelFor('a.docx').getByRole('button', { name: 'Report for a.docx' }));
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
    await findRow('a.docx');
    await userEvent.click(panelFor('a.docx').getByRole('button', { name: 'Report for a.docx' }));
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
    await findRow('loaded.docx');
    expect(
      panelFor('duplicate.docx').getByRole('button', { name: 'Force-load duplicate.docx' }),
    ).toBeVisible();
    expect(
      panelFor('created.docx').queryByRole('button', { name: 'Force-load created.docx' }),
    ).toBeNull();
    await userEvent.click(
      panelFor('loaded.docx').getByRole('button', { name: 'Force-load loaded.docx' }),
    );
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
    await findRow('created.docx');
    expect(
      panelFor('changed.docx').getByRole('button', { name: 'Redeliver changed.docx' }),
    ).toBeVisible();
    for (const key of ['failed.docx', 'queued.docx', 'duplicate.docx']) {
      expect(within(rowOf(key)).queryByRole('button', { name: /^Redeliver/ })).toBeNull();
    }
    await userEvent.click(
      panelFor('created.docx').getByRole('button', { name: 'Redeliver created.docx' }),
    );
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
      resolution: 'detached' as const,
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
    await findRow('changed.docx');
    await userEvent.click(
      panelFor('changed.docx').getByRole('button', { name: 'Detach changed.docx' }),
    );
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
    const row = panelFor('changed.docx');
    expect(row.getByText('Changed in target')).toBeInTheDocument();
    expect(row.queryByRole('button', { name: 'Detach changed.docx' })).toBeNull();
    expect(
      row.queryByRole('button', { name: "Accept the target's state for changed.docx" }),
    ).toBeNull();
    expect(row.queryByRole('button', { name: 'Redeliver changed.docx' })).toBeNull();
  });

  it('an unresolved document whose versions were never recorded offers detach only', async () => {
    const unversioned = item('unversioned.docx', 'unresolved', {
      registerEntryId: crypto.randomUUID(),
      unversioned: true,
      detail: 'the target holds this document but its versions were never recorded',
    });
    const lost = item('lost.docx', 'unresolved', { registerEntryId: crypto.randomUUID() });
    const detached = { ...unversioned, resolution: 'detached' as const, unversioned: false };
    const api = batchApi([unversioned, lost], {
      detachConversionItem: vi.fn(async () => detached),
    });
    view(api);
    await findRow('unversioned.docx');

    // An unresolved create that may have made a document has nothing to detach.
    expect(panelFor('lost.docx').queryByRole('button', { name: /^Detach/ })).toBeNull();
    const row = panelFor('unversioned.docx');
    expect(
      row.queryByRole('button', { name: "Accept the target's state for unversioned.docx" }),
    ).toBeNull();
    await userEvent.click(row.getByRole('button', { name: 'Detach unversioned.docx' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Detach unversioned.docx?' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Detach' }));
    expect(api.detachConversionItem).toHaveBeenCalledWith(unversioned.id);
  });

  it('a document gone from the target loads as a new document, after a confirmation', async () => {
    const gone = item('gone.docx', 'unresolved', {
      registerEntryId: crypto.randomUUID(),
      gone: true,
      reloadable: true,
      detail: 'The target no longer has this document (it may have been deleted).',
    });
    const reloaded = {
      batch: conversionBatch({ id: NEW_BATCH_ID, ...STARTED }),
      items: [item('gone.docx', 'queued', { redeliverOf: gone.id })],
    };
    const api = batchApi([gone], {
      reloadConversionItem: vi.fn(async () => reloaded),
    });
    view(api);
    await screen.findByText('gone.docx');
    const row = within(rowOf('gone.docx'));
    // Detach too; an update can never go through, so nothing redelivers or accepts it.
    expect(row.getByRole('button', { name: 'Detach gone.docx' })).toBeInTheDocument();
    expect(row.queryByRole('button', { name: 'Redeliver gone.docx' })).toBeNull();
    expect(row.queryByRole('button', { name: /Accept the target/ })).toBeNull();

    await userEvent.click(row.getByRole('button', { name: 'Load gone.docx as a new document' }));
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Load gone.docx as a new document?' }),
    );
    expect(dialog.getByText(/creates a new document in the target/)).toBeInTheDocument();
    expect(dialog.getByText(/no longer exists there/)).toBeInTheDocument();
    expect(api.reloadConversionItem).not.toHaveBeenCalled();
    await userEvent.click(dialog.getByRole('button', { name: 'Load as a new document' }));
    expect(api.reloadConversionItem).toHaveBeenCalledWith(gone.id);
    expect(api.reloadConversionItem).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('link', { name: 'Open the new batch' })).toHaveAttribute(
      'href',
      `#/conversion/${NEW_BATCH_ID}`,
    );
  });

  it('a row left detached by a reload whose rerun failed offers it again', async () => {
    const left = item('left.docx', 'unresolved', {
      registerEntryId: crypto.randomUUID(),
      resolution: 'detached',
      reloadable: true,
    });
    view(batchApi([left]));
    await screen.findByText('left.docx');
    const row = within(rowOf('left.docx'));
    expect(row.getByRole('button', { name: 'Load left.docx as a new document' })).toBeVisible();
    expect(row.queryByRole('button', { name: 'Detach left.docx' })).toBeNull();
  });

  it('a row that is not reloadable offers no load as a new document', async () => {
    const api = batchApi([
      item('superseded.docx', 'changed_in_target', {
        registerEntryId: crypto.randomUUID(),
        gone: true,
        resolution: 'superseded',
        reloadable: false,
      }),
      item('changed.docx', 'changed_in_target', { registerEntryId: crypto.randomUUID() }),
      item('unresolved.docx', 'unresolved', {
        registerEntryId: crypto.randomUUID(),
        unversioned: true,
      }),
    ]);
    view(api);
    await screen.findByText('changed.docx');
    expect(screen.queryByRole('button', { name: /as a new document/ })).toBeNull();
  });

  it('accept shows each changed component and needs the checkbox', async () => {
    const changed = item('changed.docx', 'changed_in_target', {
      registerEntryId: crypto.randomUUID(),
    });
    const accepted = {
      ...changed,
      resolution: 'accepted' as const,
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
    await findRow('changed.docx');
    await userEvent.click(
      panelFor('changed.docx').getByRole('button', {
        name: "Accept the target's state for changed.docx",
      }),
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
    const row = panelFor('changed.docx');
    expect(row.getByText(/the target's state was accepted/)).toBeVisible();
    expect(
      row.queryByRole('button', { name: "Accept the target's state for changed.docx" }),
    ).toBeNull();
    expect(row.queryByRole('button', { name: 'Detach changed.docx' })).toBeNull();
    // The accepted state goes in on the next run: redeliver stays on offer.
    expect(row.getByRole('button', { name: 'Redeliver changed.docx' })).toBeVisible();
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
    await findRow('changed.docx');
    await userEvent.click(
      panelFor('changed.docx').getByRole('button', {
        name: "Accept the target's state for changed.docx",
      }),
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
    await findRow('changed.docx');
    await userEvent.click(
      panelFor('changed.docx').getByRole('button', {
        name: "Accept the target's state for changed.docx",
      }),
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

  it('re-reads a started batch after reload', async () => {
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

  it('a resolved document is done, and its resolution comes from the item, not its detail', async () => {
    const entry = crypto.randomUUID();
    view(
      batchApi([
        item('open.docx', 'changed_in_target', { registerEntryId: crypto.randomUUID() }),
        item('accepted.docx', 'changed_in_target', {
          registerEntryId: entry,
          resolution: 'accepted',
          detail: 'refused: 2 components changed',
        }),
        item('detached.docx', 'changed_in_target', {
          registerEntryId: entry,
          resolution: 'detached',
        }),
        // Detail text alone says nothing: the item's resolution does.
        item('worded.docx', 'changed_in_target', {
          registerEntryId: crypto.randomUUID(),
          detail: 'detached from document D-1 by someone',
        }),
      ]),
    );
    await findRow('open.docx');
    const filter = within(screen.getByRole('group', { name: 'Show' }));
    expect(filter.getByRole('button', { name: /^Needs attention/ })).toHaveTextContent('2');
    await userEvent.click(filter.getByRole('button', { name: /^Done/ }));
    expect(listedKeys()).toEqual(['accepted.docx', 'detached.docx']);
    const accepted = panelFor('accepted.docx');
    expect(accepted.getByText(/target's state accepted/i)).toBeVisible();
    expect(accepted.queryByRole('button', { name: /^Accept/ })).toBeNull();
    expect(accepted.queryByRole('button', { name: /^Detach/ })).toBeNull();
    expect(accepted.getByRole('button', { name: 'Redeliver accepted.docx' })).toBeVisible();
    const detached = panelFor('detached.docx');
    expect(detached.getByText(/^Detached/)).toBeVisible();
    expect(detached.queryByRole('button', { name: /^Redeliver/ })).toBeNull();
    await userEvent.click(filter.getByRole('button', { name: /^Needs attention/ }));
    expect(
      panelFor('worded.docx').getByRole('button', { name: 'Detach worded.docx' }),
    ).toBeVisible();
  });

  it('a superseded row is done, and can no longer detach or accept', async () => {
    view(
      batchApi([
        item('old.docx', 'changed_in_target', {
          registerEntryId: crypto.randomUUID(),
          resolution: 'superseded',
          detail: '2 components changed in the target',
        }),
      ]),
    );
    await findRow('old.docx');
    const filter = within(screen.getByRole('group', { name: 'Show' }));
    expect(filter.getByRole('button', { name: /^Needs attention/ })).toHaveTextContent('0');
    await userEvent.click(filter.getByRole('button', { name: /^Done/ }));
    const row = panelFor('old.docx');
    expect(row.getByText(/^Superseded by a later run/)).toBeVisible();
    expect(row.queryByRole('button', { name: /^Detach/ })).toBeNull();
    expect(row.queryByRole('button', { name: /^Accept/ })).toBeNull();
  });

  it('in flight is final, and points at the other batch', async () => {
    vi.useFakeTimers();
    try {
      const getConversionBatch = vi.fn(async () => detailOf([item('a.docx', 'in_flight')]));
      const page = view(batchApi([], { getConversionBatch }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(within(rowOf('a.docx')).getByText('In flight')).toBeInTheDocument();
      expect(rowOf('a.docx')).toHaveTextContent(/another batch is delivering this document/i);
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(getConversionBatch).toHaveBeenCalledTimes(1);
      page.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces progress as rows settle', async () => {
    vi.useFakeTimers();
    try {
      const a = item('a.docx', 'queued');
      const b = item('b.docx', 'decomposing');
      const getConversionBatch = vi
        .fn()
        .mockResolvedValueOnce(detailOf([a, b]))
        .mockResolvedValueOnce(detailOf([{ ...a, outcome: 'delivering' }, b]))
        .mockResolvedValueOnce(detailOf([{ ...a, outcome: 'created' }, b]))
        .mockResolvedValue(
          detailOf([
            { ...a, outcome: 'created' },
            { ...b, outcome: 'failed' },
          ]),
        );
      const page = view(batchApi([], { getConversionBatch }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      const progress = screen.getByRole('status', { name: 'Progress' });
      expect(progress).toHaveAttribute('aria-live', 'polite');
      expect(progress).toHaveAttribute('aria-atomic', 'true');
      expect(progress).toHaveTextContent('0 of 2 documents done');
      await act(() => vi.advanceTimersByTimeAsync(3000)); // a moved on, but nothing settled
      expect(progress).toHaveTextContent('0 of 2 documents done');
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(progress).toHaveTextContent('1 of 2 documents done');
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(progress).toHaveTextContent('All 2 documents done; 1 needs attention');
      page.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a first read that fails offers to try again, and retries on its own', async () => {
    vi.useFakeTimers();
    try {
      const getConversionBatch = vi
        .fn()
        .mockRejectedValueOnce(new ApiError('the server is busy', 503))
        .mockRejectedValueOnce(new ApiError('the server is busy', 503))
        .mockResolvedValue(detailOf([item('a.docx', 'created')]));
      const page = view(batchApi([], { getConversionBatch }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByRole('alert')).toHaveTextContent('the server is busy');
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(getConversionBatch).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('table', { name: 'Documents' })).toBeNull();
      await act(async () => {
        screen.getByRole('button', { name: 'Try again' }).click();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getConversionBatch).toHaveBeenCalledTimes(3);
      expect(rowOf('a.docx')).toBeInTheDocument();
      page.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a batch gone during a poll says so, and stops', async () => {
    vi.useFakeTimers();
    try {
      const getConversionBatch = vi
        .fn()
        .mockResolvedValueOnce(detailOf([item('a.docx', 'queued')]))
        .mockRejectedValue(new ApiError('not found', 404));
      const page = view(batchApi([], { getConversionBatch }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(screen.getByText(/No such batch/)).toBeVisible();
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(getConversionBatch).toHaveBeenCalledTimes(2);
      page.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows only a web link to the target', async () => {
    view(batchApi([item('a.docx', 'created', { link: 'javascript:alert(1)' })]));
    await findRow('a.docx');
    expect(within(rowOf('a.docx')).queryByRole('link')).toBeNull();
  });

  it('says when a report has nothing to flag', async () => {
    view(
      batchApi([item('a.docx', 'created')], {
        getConversionReport: vi.fn(async () => ({ flags: [] })),
      }),
    );
    await findRow('a.docx');
    await userEvent.click(screen.getByRole('button', { name: 'Report for a.docx' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Report: a.docx' }));
    expect(await dialog.findByText(/Nothing to flag/)).toBeVisible();
  });

  it('a double click acts once', async () => {
    function never<T>(): Promise<T> {
      return new Promise<T>(() => undefined);
    }
    const loaded = item('loaded.docx', 'already_loaded', { registerEntryId: crypto.randomUUID() });
    const changed = item('changed.docx', 'changed_in_target', {
      registerEntryId: crypto.randomUUID(),
    });
    const other = item('other.docx', 'changed_in_target', {
      registerEntryId: crypto.randomUUID(),
    });
    const api = batchApi([loaded, changed, other], {
      forceConversionItem: vi.fn(() => never<BatchDetail>()),
      redeliverConversionItem: vi.fn(() => never<BatchDetail>()),
      detachConversionItem: vi.fn(() => never<Item>()),
      previewAccept: vi.fn(async (): Promise<AcceptPreview> => ({
        changed: [{ id: 'section-1', expected: '1', actual: '2' }],
        acceptable: true,
        updatedAt: 'T1',
      })),
      acceptTargetState: vi.fn(() => never<AcceptedTargetState>()),
    });
    view(api);
    await findRow('loaded.docx');
    const fast = (el: HTMLElement) =>
      act(() => {
        el.click();
        el.click();
      });

    await fast(panelFor('loaded.docx').getByRole('button', { name: 'Force-load loaded.docx' }));
    expect(api.forceConversionItem).toHaveBeenCalledTimes(1);

    await userEvent.click(
      panelFor('changed.docx').getByRole('button', { name: 'Redeliver changed.docx' }),
    );
    let dialog = within(await screen.findByRole('dialog', { name: 'Redeliver changed.docx' }));
    await fast(dialog.getByRole('button', { name: 'Redeliver' }));
    expect(api.redeliverConversionItem).toHaveBeenCalledTimes(1);
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));

    await userEvent.click(screen.getByRole('button', { name: 'Detach changed.docx' }));
    dialog = within(await screen.findByRole('dialog', { name: 'Detach changed.docx?' }));
    await fast(dialog.getByRole('button', { name: 'Detach' }));
    expect(api.detachConversionItem).toHaveBeenCalledTimes(1);
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));

    await userEvent.click(
      panelFor('other.docx').getByRole('button', {
        name: "Accept the target's state for other.docx",
      }),
    );
    dialog = within(await screen.findByRole('dialog', { name: "Accept the target's state" }));
    await dialog.findByText('section-1');
    await userEvent.click(dialog.getByRole('checkbox'));
    await fast(dialog.getByRole('button', { name: 'Accept and overwrite' }));
    expect(api.acceptTargetState).toHaveBeenCalledTimes(1);
  });

  it('a stale preview whose re-read fails cannot be confirmed', async () => {
    const changed = item('changed.docx', 'changed_in_target', {
      registerEntryId: crypto.randomUUID(),
    });
    const api = batchApi([changed], {
      previewAccept: vi
        .fn()
        .mockResolvedValueOnce({
          changed: [{ id: 'section-1', expected: '3', actual: '5' }],
          acceptable: true,
          updatedAt: 'T1',
        })
        .mockRejectedValue(new ApiError('the server is busy', 503)),
      acceptTargetState: vi.fn(async () => {
        throw new ApiError('changed', 409, { code: 'stale_preview' });
      }),
    });
    view(api);
    await findRow('changed.docx');
    await userEvent.click(
      screen.getByRole('button', { name: "Accept the target's state for changed.docx" }),
    );
    const dialog = within(await screen.findByRole('dialog', { name: "Accept the target's state" }));
    await dialog.findByText('section-1');
    await userEvent.click(dialog.getByRole('checkbox'));
    await userEvent.click(dialog.getByRole('button', { name: 'Accept and overwrite' }));
    expect(await dialog.findByText(/the server is busy/)).toBeVisible();
    expect(dialog.getByRole('button', { name: 'Accept and overwrite' })).toBeDisabled();
    expect(dialog.queryByRole('checkbox')).toBeNull();
    expect(dialog.queryByText('section-1')).toBeNull();
  });

  it('an open dialog stays open when a poll changes its document', async () => {
    vi.useFakeTimers();
    try {
      const changed = item('changed.docx', 'changed_in_target', {
        registerEntryId: crypto.randomUUID(),
      });
      const running = item('running.docx', 'queued');
      const getConversionBatch = vi
        .fn()
        .mockResolvedValueOnce(detailOf([changed, running]))
        .mockResolvedValue(detailOf([{ ...changed, resolution: 'accepted' }, running]));
      const page = view(batchApi([], { getConversionBatch }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      // Only the documents needing attention: once accepted elsewhere, its row leaves the list.
      act(() => fireEvent.click(screen.getByRole('button', { name: /^Needs attention/ })));
      act(() => fireEvent.click(screen.getByRole('button', { name: 'Detach changed.docx' })));
      expect(screen.getByRole('dialog', { name: 'Detach changed.docx?' })).toBeVisible();
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(screen.queryByRole('table', { name: 'Documents' })).toBeNull();
      const dialog = within(screen.getByRole('dialog', { name: 'Detach changed.docx?' }));
      expect(dialog.getByRole('status')).toHaveTextContent(
        /changed while this was open: the target's state was accepted/i,
      );
      expect(dialog.getByRole('button', { name: 'Detach' })).toBeDisabled();
      page.unmount();
    } finally {
      vi.useRealTimers();
    }
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
    const list = within(await screen.findByRole('table', { name: 'Earlier batches' }));
    await waitFor(() => expect(list.getAllByRole('row')).toHaveLength(2));
    const links = list.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      `#/conversion/${newer.id}`,
      `#/conversion/${older.id}`,
    ]);
    const [first, second] = list.getAllByRole('row');
    expect(first).toHaveTextContent('Controlled documents');
    expect(first).toHaveTextContent('2 docs');
    expect(first).toHaveTextContent('1 queued');
    expect(first).toHaveTextContent('1 changed in target');
    expect(second).toHaveTextContent('2 created');
    expect(second).toHaveTextContent('1 failed');
  });
});
