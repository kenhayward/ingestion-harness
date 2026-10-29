import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ITEM_OUTCOMES, type BatchSummary, type Item, type ItemOutcome } from '@ih/shared';
import { ApiError } from '../src/api/client.js';
import { BatchView } from '../src/conversion/BatchView.js';
import { ConversionPage } from '../src/conversion/ConversionPage.js';
import { TARGET_KEY } from '../src/conversion/NewBatch.js';
import { conversionBatch, conversionItem, fakeApi } from './fake-api.js';

const BATCH_ID = '6f1c2a10-4b7e-4c55-9d2a-0c8e7b3f5a11';
const NEW_BATCH_ID = '7a2d3b21-5c8f-4d66-8e3b-1d9f8c4a6b22';
const STARTED = { state: 'started' as const, startedAt: '2026-10-26T09:44:00.000Z' };
const TARGETS = [{ id: 'documents', label: 'Controlled documents', sinkName: 'Document sink' }];

const item = (sourceKey: string, outcome: ItemOutcome, o: Partial<Item> = {}) =>
  conversionItem({ sourceKey, filename: sourceKey.split('/').pop()!, outcome, ...o });

function batchApi(items: Item[], overrides: Parameters<typeof fakeApi>[0] = {}, force = false) {
  return fakeApi({
    listConversionTargets: vi.fn(async () => TARGETS),
    getConversionBatch: vi.fn(async () => ({
      batch: conversionBatch({
        id: BATCH_ID,
        ...STARTED,
        force,
        createdBy: { id: 'u1', name: 'Priya' },
      }),
      items,
    })),
    ...overrides,
  });
}

const table = () => within(screen.getByRole('table', { name: 'Documents' }));
const listed = () =>
  table()
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.querySelector('.mono')?.textContent);
const panel = () => within(screen.getByRole('complementary', { name: 'Document' }));

describe('the Conversion tab redesign: a batch', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('heads the batch with where it went, who started it, and its totals', async () => {
    const api = batchApi(
      [
        item('a.docx', 'created'),
        item('b.docx', 'updated'),
        item('c.docx', 'already_loaded'),
        item('d.docx', 'changed_in_target'),
        item('e.docx', 'failed'),
      ],
      {},
      true,
    );
    render(<ConversionPage api={api} batchId={BATCH_ID} />);
    expect(await screen.findByRole('heading', { level: 1, name: /^Batch · / })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Conversion' })).toHaveAttribute(
      'href',
      '#/conversion',
    );
    const meta = screen.getByText(/started by/).closest('p')!;
    expect(meta).toHaveTextContent('Controlled documents');
    expect(meta).toHaveTextContent('Priya');
    expect(meta).toHaveTextContent('Force-load');
    const totals = within(screen.getByRole('group', { name: 'Totals' }));
    expect(totals.getByText('documents').previousSibling).toHaveTextContent('5');
    expect(totals.getByText('created or updated').previousSibling).toHaveTextContent('2');
    expect(totals.getByText('already loaded').previousSibling).toHaveTextContent('1');
    expect(totals.getByText('need attention').previousSibling).toHaveTextContent('1');
    expect(totals.getByText('failed').previousSibling).toHaveTextContent('1');
  });

  it('filters to the failed documents, and finds a document by its path', async () => {
    render(
      <BatchView
        api={batchApi([
          item('QA/a.docx', 'created'),
          item('QA/b.docx', 'failed'),
          item('Labs/c.docx', 'failed'),
          item('Labs/d.docx', 'changed_in_target'),
        ])}
        batchId={BATCH_ID}
      />,
    );
    await screen.findByRole('table', { name: 'Documents' });
    const show = within(screen.getByRole('group', { name: 'Show' }));
    expect(show.getByRole('button', { name: /^Failed/ })).toHaveTextContent('2');
    await userEvent.click(show.getByRole('button', { name: /^Failed/ }));
    expect(listed()).toEqual(['QA/b.docx', 'Labs/c.docx']);
    await userEvent.click(show.getByRole('button', { name: /^All/ }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a document' }), 'labs/');
    expect(listed()).toEqual(['Labs/c.docx', 'Labs/d.docx']);
  });

  it('shows the selected document beside the list: why it failed, its times, its original', async () => {
    const failed = item('QA/b.docx', 'failed', {
      detail: 'Decompose: table 4 has merged cells',
      sizeBytes: 412 * 1024,
      startedAt: '2026-10-26T09:45:01.000Z',
      finishedAt: '2026-10-26T09:47:05.000Z',
    });
    const api = batchApi([item('QA/a.docx', 'created'), failed]);
    render(<BatchView api={api} batchId={BATCH_ID} />);
    // The first document needing attention is selected to begin with.
    await waitFor(() => expect(panel().getByRole('heading', { name: 'b.docx' })).toBeVisible());
    const picked = table().getByText('QA/b.docx').closest('tr')!;
    expect(picked).toHaveAttribute('aria-current', 'true');
    expect(picked).not.toHaveAttribute('aria-selected');
    expect(table().getByText('QA/a.docx').closest('tr')).not.toHaveAttribute('aria-current');
    expect(panel().getByText('Why it failed').parentElement).toHaveTextContent(
      'Decompose: table 4 has merged cells',
    );
    expect(panel().getByText(/412 KB/)).toBeVisible();
    expect(panel().getByText(/took 2 min 4 s/)).toBeVisible();
    expect(panel().getByRole('link', { name: 'Download original' })).toHaveAttribute(
      'href',
      `/api/conversions/items/${failed.id}/source`,
    );
    await userEvent.click(table().getByRole('button', { name: 'QA/a.docx' }));
    expect(panel().getByRole('heading', { name: 'a.docx' })).toBeVisible();
    expect(panel().queryByText('Why it failed')).toBeNull();
    expect(panel().queryByRole('button', { name: /^Re-run/ })).toBeNull();
  });

  it('re-runs the chosen failed documents in this batch, and stays on it as they run', async () => {
    const b = item('QA/b.docx', 'failed', { detail: 'merged cells' });
    const c = item('Labs/c.docx', 'failed', { detail: 'target unavailable' });
    const done = item('QA/a.docx', 'created');
    const batch = conversionBatch({ id: BATCH_ID, ...STARTED, force: true });
    const api = batchApi(
      [done, b, c],
      {
        retryConversionItems: vi.fn(async () => ({
          batch,
          items: [done, { ...b, outcome: 'queued' as const, detail: null }, c],
        })),
      },
      true,
    );
    window.location.hash = `#/conversion/${BATCH_ID}`;
    render(<BatchView api={api} batchId={BATCH_ID} pollMs={60_000} />);
    // On the list's bar, after the find box.
    const find = await screen.findByRole('searchbox', { name: 'Find a document' });
    const rerun = screen.getByRole('button', { name: 'Re-run Failures' });
    expect(rerun.parentElement).toBe(find.parentElement);
    expect(find.compareDocumentPosition(rerun) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(rerun);
    const dialog = within(screen.getByRole('dialog', { name: 'Re-run 2 failed documents' }));
    expect(dialog.getByRole('checkbox', { name: /QA\/b\.docx/ })).toBeChecked();
    expect(dialog.getByText('merged cells')).toBeVisible();
    const keep = dialog.getByRole('switch', { name: /Keep Force-load/ });
    expect(keep).toBeChecked(); // as the batch was started
    await userEvent.click(dialog.getByRole('checkbox', { name: /Labs\/c\.docx/ }));
    await userEvent.click(keep);
    await userEvent.click(dialog.getByRole('button', { name: 'Re-run 1 document' }));
    expect(api.retryConversionItems).toHaveBeenCalledWith(BATCH_ID, {
      itemIds: [b.id],
      force: false,
      autoApprove: false,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.hash).toBe(`#/conversion/${BATCH_ID}`);
    // Its row shows it queued again, and the list refreshes while it runs.
    const row = within(table().getByText('QA/b.docx').closest('tr')!);
    expect(row.getByText('Queued')).toBeVisible();
    expect(screen.getByText(/this list refreshes every few seconds/)).toBeVisible();
  });

  it('re-runs auto-approving only when ticked: it starts off, whatever the batch', async () => {
    const b = item('QA/b.pdf', 'failed');
    const api = batchApi([b], {
      getConversionBatch: vi.fn(async () => ({
        batch: conversionBatch({ id: BATCH_ID, ...STARTED, autoApprove: true }),
        items: [b],
      })),
      retryConversionItems: vi.fn(async () => ({
        batch: conversionBatch({ id: BATCH_ID, ...STARTED }),
        items: [{ ...b, outcome: 'queued' as const }],
      })),
    });
    render(<BatchView api={api} batchId={BATCH_ID} pollMs={60_000} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Re-run Failures' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Re-run 1 failed document' }));
    const switches = dialog.getAllByRole('switch');
    const auto = dialog.getByRole('switch', { name: /Auto approve/ });
    // Under Force-load.
    expect(switches.indexOf(auto)).toBe(switches.length - 1);
    expect(switches[0]).toHaveAccessibleName(/Keep Force-load/);
    expect(auto).not.toBeChecked();
    await userEvent.click(auto);
    await userEvent.click(dialog.getByRole('button', { name: 'Re-run 1 document' }));
    expect(api.retryConversionItems).toHaveBeenCalledWith(BATCH_ID, {
      itemIds: [b.id],
      force: false,
      autoApprove: true,
    });
  });

  it('offers no Re-run Failures with nothing failed to re-run', async () => {
    render(<BatchView api={batchApi([item('a.docx', 'created')])} batchId={BATCH_ID} />);
    await screen.findByRole('table', { name: 'Documents' });
    expect(screen.queryByRole('button', { name: 'Re-run Failures' })).toBeNull();
  });

  it('cannot re-run with nothing chosen', async () => {
    render(<BatchView api={batchApi([item('b.docx', 'failed')])} batchId={BATCH_ID} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Re-run Failures' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Re-run 1 failed document' }));
    await userEvent.click(dialog.getByRole('checkbox', { name: /b\.docx/ }));
    expect(dialog.getByRole('button', { name: /^Re-run/ })).toBeDisabled();
  });

  it('a refused re-run says why, and the dialog stays open', async () => {
    const api = batchApi([item('b.docx', 'failed')], {
      retryConversionItems: vi.fn(async () => {
        throw new ApiError('an earlier re-run of b.docx is still running', 409);
      }),
    });
    render(<BatchView api={api} batchId={BATCH_ID} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Re-run Failures' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Re-run 1 failed document' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Re-run 1 document' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('still running');
  });

  it('re-runs one document from its panel, staying on the batch', async () => {
    const b = item('b.docx', 'failed');
    const c = item('c.docx', 'failed');
    const api = batchApi([b, c], {
      retryConversionItems: vi.fn(async () => ({
        batch: conversionBatch({ id: BATCH_ID, ...STARTED }),
        items: [{ ...b, outcome: 'decomposing' as const }, c],
      })),
    });
    window.location.hash = `#/conversion/${BATCH_ID}`;
    render(<BatchView api={api} batchId={BATCH_ID} pollMs={60_000} />);
    await waitFor(() => expect(panel().getByRole('heading', { name: 'b.docx' })).toBeVisible());
    await userEvent.click(panel().getByRole('button', { name: 'Re-run this document' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Re-run b.docx' }));
    expect(dialog.getAllByRole('checkbox')).toHaveLength(1);
    await userEvent.click(dialog.getByRole('button', { name: 'Re-run 1 document' }));
    expect(api.retryConversionItems).toHaveBeenCalledWith(BATCH_ID, {
      itemIds: [b.id],
      force: false,
      autoApprove: false,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.hash).toBe(`#/conversion/${BATCH_ID}`);
    expect(
      within(table().getByText('b.docx').closest('tr')!).getByText('Decomposing'),
    ).toBeVisible();
  });

  it("a row's menu re-runs, opens the report and downloads the original", async () => {
    const b = item('b.docx', 'failed');
    const a = item('a.docx', 'created', { registerEntryId: crypto.randomUUID() });
    render(<BatchView api={batchApi([a, b])} batchId={BATCH_ID} />);
    await screen.findByRole('table', { name: 'Documents' });
    await userEvent.click(table().getByRole('button', { name: 'Actions for b.docx' }));
    const menu = within(screen.getByRole('menu', { name: 'Actions for b.docx' }));
    expect(menu.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Re-run',
      'View report',
      'Download original',
    ]);
    expect(menu.getByRole('menuitem', { name: 'Download original' })).toHaveAttribute(
      'href',
      `/api/conversions/items/${b.id}/source`,
    );
    await userEvent.click(menu.getByRole('menuitem', { name: 'Re-run' }));
    expect(screen.getByRole('dialog', { name: 'Re-run b.docx' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(table().getByRole('button', { name: 'Actions for a.docx' }));
    const other = within(screen.getByRole('menu', { name: 'Actions for a.docx' }));
    expect(other.queryByRole('menuitem', { name: 'Re-run' })).toBeNull();
    expect(other.getByRole('menuitem', { name: 'Redeliver' })).toBeVisible();
    await userEvent.click(other.getByRole('menuitem', { name: 'View report' }));
    expect(await screen.findByRole('dialog', { name: 'Report: a.docx' })).toBeVisible();
  });

  it('measures the rows that fit once the batch has loaded', async () => {
    const observed: Element[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(el: Element) {
          observed.push(el);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    // Seven 36 px rows fit the rows' box; nothing else has a height.
    const height = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('batch-list-rows') ? 7 * 36 : 0;
      });
    try {
      const items = Array.from({ length: 12 }, (_, n) => item(`d${n}.docx`, 'created'));
      render(<BatchView api={batchApi(items)} batchId={BATCH_ID} />);
      await screen.findByRole('table', { name: 'Documents' });
      await waitFor(() => expect(listed()).toHaveLength(7));
      const pager = within(screen.getByRole('navigation', { name: 'Pages of documents' }));
      expect(pager.getByText(/Page/)).toHaveTextContent('Page 1 of 2');
      expect(observed).toEqual([document.querySelector('.batch-list-rows')]);
    } finally {
      height.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('a document already re-run is re-run no more from here, and says where', async () => {
    const at = '2026-10-26T10:15:00.000Z';
    const a = item('QA/a.docx', 'failed', { rerunIn: NEW_BATCH_ID, rerunAt: at });
    const b = item('QA/b.docx', 'failed');
    render(<BatchView api={batchApi([a, b])} batchId={BATCH_ID} />);
    await screen.findByRole('table', { name: 'Documents' });
    // b alone is offered: a was re-run in another batch.
    expect(screen.getByRole('button', { name: 'Re-run Failures' })).toBeVisible();
    // Still failed in this batch's record.
    const show = within(screen.getByRole('group', { name: 'Show' }));
    expect(show.getByRole('button', { name: /^Failed/ })).toHaveTextContent('2');

    const row = within(table().getByText('QA/a.docx').closest('tr')!);
    const where = row.getByRole('link', { name: /^Re-run in batch / });
    expect(where).toHaveAttribute('href', `#/conversion/${NEW_BATCH_ID}`);
    expect(where.textContent).toContain(
      new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    );
    await userEvent.click(table().getByRole('button', { name: 'QA/a.docx' }));
    expect(panel().getByRole('link', { name: /^Re-run in batch / })).toHaveAttribute(
      'href',
      `#/conversion/${NEW_BATCH_ID}`,
    );
    expect(panel().queryByRole('button', { name: /Re-run this document/ })).toBeNull();
    await userEvent.click(table().getByRole('button', { name: 'Actions for QA/a.docx' }));
    const menu = within(screen.getByRole('menu', { name: 'Actions for QA/a.docx' }));
    expect(menu.queryByRole('menuitem', { name: 'Re-run' })).toBeNull();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: 'Re-run Failures' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Re-run 1 failed document' }));
    expect(dialog.getAllByRole('checkbox')).toHaveLength(1);
    expect(dialog.getByRole('checkbox', { name: /QA\/b\.docx/ })).toBeChecked();
  });

  it("a dialog opened from a row's menu gives focus back to the menu's button", async () => {
    const a = item('a.docx', 'created', { registerEntryId: crypto.randomUUID() });
    render(<BatchView api={batchApi([a])} batchId={BATCH_ID} />);
    await screen.findByRole('table', { name: 'Documents' });
    const button = table().getByRole('button', { name: 'Actions for a.docx' });
    await userEvent.click(button);
    const menu = within(screen.getByRole('menu', { name: 'Actions for a.docx' }));
    await userEvent.click(menu.getByRole('menuitem', { name: 'Redeliver' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Redeliver a.docx' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(button).toHaveFocus();
  });

  it("a row's menu opens upward when the list has no room below it", async () => {
    const rect = (top: number, bottom: number) =>
      ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top }) as DOMRect;
    const box = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.classList.contains('batch-list-rows')) return rect(0, 300);
      if (this.classList.contains('row-menu')) {
        // The menu sits under its row: the last row's runs past the list's bottom.
        const last = this.closest('tr')?.querySelector('.mono')?.textContent === 'z.docx';
        return last ? rect(280, 420) : rect(40, 180);
      }
      return rect(0, 0);
    });
    try {
      render(
        <BatchView
          api={batchApi([item('a.docx', 'created'), item('z.docx', 'created')])}
          batchId={BATCH_ID}
        />,
      );
      await screen.findByRole('table', { name: 'Documents' });
      await userEvent.click(table().getByRole('button', { name: 'Actions for a.docx' }));
      expect(screen.getByRole('menu', { name: 'Actions for a.docx' })).not.toHaveClass('opens-up');
      await userEvent.keyboard('{Escape}');
      await userEvent.click(table().getByRole('button', { name: 'Actions for z.docx' }));
      expect(screen.getByRole('menu', { name: 'Actions for z.docx' })).toHaveClass('opens-up');
    } finally {
      box.mockRestore();
    }
  });

  it('pages the documents to fit', async () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((n) => item(`${n}.docx`, 'created'));
    render(<BatchView api={batchApi(items)} batchId={BATCH_ID} rowsPerPage={2} />);
    await screen.findByRole('table', { name: 'Documents' });
    const pager = within(screen.getByRole('navigation', { name: 'Pages of documents' }));
    expect(pager.getByText(/Page/)).toHaveTextContent('Page 1 of 3');
    expect(listed()).toEqual(['a.docx', 'b.docx']);
    expect(pager.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await userEvent.click(pager.getByRole('button', { name: 'Next page' }));
    expect(listed()).toEqual(['c.docx', 'd.docx']);
    await userEvent.click(pager.getByRole('button', { name: 'Next page' }));
    expect(listed()).toEqual(['e.docx']);
    expect(pager.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });
});

function summary(o: Partial<BatchSummary>, counts: Partial<Record<ItemOutcome, number>> = {}) {
  const all = Object.fromEntries(ITEM_OUTCOMES.map((k) => [k, counts[k] ?? 0])) as Record<
    ItemOutcome,
    number
  >;
  const itemCount = Object.values(all).reduce((a, b) => a + b, 0);
  return { ...conversionBatch({ ...STARTED, ...o }), itemCount, counts: all };
}

describe('the Conversion tab redesign: a new batch and the earlier ones', () => {
  const page = (o: Parameters<typeof fakeApi>[0] = {}) =>
    fakeApi({ listConversionTargets: vi.fn(async () => TARGETS), ...o });

  it('numbers the steps, and the button says how many documents it converts', async () => {
    render(<ConversionPage api={page()} />);
    await screen.findByRole('option', { name: 'Controlled documents · Document sink' });
    expect(screen.getByRole('heading', { name: '1 Target' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '2 Word or PDF files' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '3 Options' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Convert documents' })).toBeDisabled();
    await userEvent.upload(screen.getByLabelText('Choose files'), new File(['PK'], 'a.docx'));
    expect(screen.getByRole('button', { name: 'Convert 1 document' })).toBeEnabled();
    await userEvent.upload(screen.getByLabelText('Choose files'), new File(['PK'], 'b.docx'));
    expect(screen.getByRole('button', { name: 'Convert 2 documents' })).toBeEnabled();
    expect(screen.getByText(/to Controlled documents · Document sink/)).toBeVisible();
  });

  it('counts the files picked, and clears them all', async () => {
    render(<ConversionPage api={page()} />);
    await screen.findByRole('option', { name: 'Controlled documents · Document sink' });
    await userEvent.upload(screen.getByLabelText('Choose files'), [
      new File(['PK'], 'a.docx'),
      new File(['PK'], 'a.docx'),
    ]);
    expect(screen.getByText(/2 files/).closest('div')).toHaveTextContent('1 ready · 1 skipped');
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.queryByRole('list', { name: 'Files to convert' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Convert documents' })).toBeDisabled();
  });

  it('force-load is a switch', async () => {
    render(<ConversionPage api={page()} />);
    const force = await screen.findByRole('switch', { name: 'Force-load' });
    expect(force).not.toBeChecked();
    await userEvent.click(force);
    expect(force).toBeChecked();
  });

  it('lists the earlier batches as a table: state, outcomes, who started them', async () => {
    const failed = summary(
      {
        id: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-10-24T09:00:00.000Z',
        force: true,
      },
      { created: 21, updated: 2, failed: 1 },
    );
    const done = summary(
      {
        id: '22222222-2222-4222-8222-222222222222',
        createdAt: '2026-10-25T09:00:00.000Z',
        createdBy: { id: 'u2', name: 'Priya' },
      },
      { created: 12 },
    );
    const running = summary(
      { id: '33333333-3333-4333-8333-333333333333', createdAt: '2026-10-26T09:00:00.000Z' },
      { delivering: 3, created: 5 },
    );
    render(
      <ConversionPage
        api={page({ listConversionBatches: vi.fn(async () => [failed, done, running]) })}
      />,
    );
    const batches = within(await screen.findByRole('table', { name: 'Earlier batches' }));
    await waitFor(() => expect(batches.getAllByRole('row')).toHaveLength(3));
    const [r1, r2, r3] = batches.getAllByRole('row');
    expect(within(r1!).getByRole('img', { name: 'Under way' })).toBeVisible();
    expect(within(r2!).getByRole('img', { name: 'Done' })).toBeVisible();
    expect(within(r3!).getByRole('img', { name: 'Some failed' })).toBeVisible();
    expect(r2).toHaveTextContent('12 docs');
    expect(r2).toHaveTextContent('12 created');
    expect(r2).toHaveTextContent('Priya');
    expect(within(r3!).getByText('1 failed')).toHaveClass('pill', 'tone-danger');
    expect(r3).toHaveTextContent('Force-load');
    expect(within(r1!).getByRole('link')).toHaveAttribute('href', `#/conversion/${running.id}`);
  });

  it('pages the earlier batches', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      summary(
        {
          id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          createdAt: `2026-10-${String(10 + i).padStart(2, '0')}T09:00:00.000Z`,
        },
        { created: 1 },
      ),
    );
    render(<ConversionPage api={page({ listConversionBatches: vi.fn(async () => many) })} />);
    const batches = within(await screen.findByRole('table', { name: 'Earlier batches' }));
    await waitFor(() => expect(batches.getAllByRole('row')).toHaveLength(10));
    const pager = within(screen.getByRole('navigation', { name: 'Pages of batches' }));
    expect(pager.getByText(/Page/)).toHaveTextContent('Page 1 of 2');
    await userEvent.click(pager.getByRole('button', { name: 'Older batches' }));
    expect(batches.getAllByRole('row')).toHaveLength(2);
  });

  describe('the target', () => {
    const TWO = [
      { id: 'documents', label: 'Controlled documents', sinkName: 'Document sink' },
      { id: 'sops', label: 'SOPs', sinkName: 'Document sink' },
    ];
    afterEach(() => localStorage.clear());
    const target = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'Target' });

    it('comes back to the one picked last time', async () => {
      const api = page({ listConversionTargets: vi.fn(async () => TWO) });
      const first = render(<ConversionPage api={api} />);
      await screen.findByRole('option', { name: 'SOPs · Document sink' });
      expect(target()).toHaveValue('documents');
      await userEvent.selectOptions(target(), 'sops');
      first.unmount();
      render(<ConversionPage api={api} />);
      await screen.findByRole('option', { name: 'SOPs · Document sink' });
      await waitFor(() => expect(target()).toHaveValue('sops'));
    });

    it('starts on the first when the one picked is no longer listed', async () => {
      localStorage.setItem(TARGET_KEY, 'gone');
      render(<ConversionPage api={page({ listConversionTargets: vi.fn(async () => TWO) })} />);
      await screen.findByRole('option', { name: 'SOPs · Document sink' });
      expect(target()).toHaveValue('documents');
    });
  });

  const OLD = summary(
    { id: '44444444-4444-4444-8444-444444444444', createdAt: '2026-10-20T09:00:00.000Z' },
    { created: 3 },
  );
  const BUSY = summary(
    { id: '55555555-5555-4555-8555-555555555555', createdAt: '2026-10-21T09:00:00.000Z' },
    { created: 1, delivering: 1, awaiting_review: 1 },
  );
  const deleteOf = (row: HTMLElement) =>
    within(row).getByRole('button', { name: /^Delete the batch of/ });

  it('a batch with documents not finished cannot be deleted, and says why', async () => {
    render(
      <ConversionPage api={page({ listConversionBatches: vi.fn(async () => [OLD, BUSY]) })} />,
    );
    const batches = within(await screen.findByRole('table', { name: 'Earlier batches' }));
    await waitFor(() => expect(batches.getAllByRole('row')).toHaveLength(2));
    const [busy, old] = batches.getAllByRole('row');
    expect(deleteOf(busy!)).toBeDisabled();
    expect(deleteOf(busy!)).toHaveAttribute('title', '2 documents not finished yet');
    expect(deleteOf(old!)).toBeEnabled();
    expect(deleteOf(old!)).toHaveAttribute('title', 'Delete…');
  });

  it('deletes a batch once confirmed, and it leaves the list', async () => {
    const deleteConversionBatch = vi.fn(async () => undefined);
    render(
      <ConversionPage
        api={page({ listConversionBatches: vi.fn(async () => [OLD, BUSY]), deleteConversionBatch })}
      />,
    );
    const batches = within(await screen.findByRole('table', { name: 'Earlier batches' }));
    await waitFor(() => expect(batches.getAllByRole('row')).toHaveLength(2));
    await userEvent.click(deleteOf(batches.getAllByRole('row')[1]!));
    const dialog = within(screen.getByRole('dialog', { name: 'Delete this batch?' }));
    expect(dialog.getByText(/3 documents, leaves this list/)).toBeVisible();
    expect(dialog.getByText(/stay in the target/)).toBeVisible();
    expect(deleteConversionBatch).not.toHaveBeenCalled();
    await userEvent.click(dialog.getByRole('button', { name: 'Delete batch' }));
    expect(deleteConversionBatch).toHaveBeenCalledWith(OLD.id);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(batches.getAllByRole('row')).toHaveLength(1);
  });

  it('Cancel deletes nothing, and a refusal stays shown in the dialog', async () => {
    const deleteConversionBatch = vi.fn(async () => {
      throw new ApiError('1 document is not finished yet', 409);
    });
    render(
      <ConversionPage
        api={page({ listConversionBatches: vi.fn(async () => [OLD]), deleteConversionBatch })}
      />,
    );
    const batches = within(await screen.findByRole('table', { name: 'Earlier batches' }));
    await waitFor(() => expect(batches.getAllByRole('row')).toHaveLength(1));
    await userEvent.click(deleteOf(batches.getAllByRole('row')[0]!));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deleteConversionBatch).not.toHaveBeenCalled();
    await userEvent.click(deleteOf(batches.getAllByRole('row')[0]!));
    await userEvent.click(screen.getByRole('button', { name: 'Delete batch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1 document is not finished yet');
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(batches.getAllByRole('row')).toHaveLength(1);
  });
});
