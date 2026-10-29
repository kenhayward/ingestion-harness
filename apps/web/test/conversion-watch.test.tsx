import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Item, ItemOutcome } from '@ih/shared';
import { ConversionPage } from '../src/conversion/ConversionPage.js';
import { conversionBatch, conversionItem, fakeApi } from './fake-api.js';

const BATCH_ID = '6f1c2a10-4b7e-4c55-9d2a-0c8e7b3f5a11';
const WATCH = { id: '9b3e5c10-6d1a-4e77-8f20-2a4c6e8b0d11', name: 'Inbox' };
const TARGETS = [{ id: 'documents', label: 'Controlled documents', sinkName: 'Document sink' }];

const item = (sourceKey: string, outcome: ItemOutcome, o: Partial<Item> = {}) =>
  conversionItem({ sourceKey, filename: sourceKey, outcome, ...o });

function batchApi(items: Item[], watch: typeof WATCH | null) {
  return fakeApi({
    listConversionTargets: vi.fn(async () => TARGETS),
    getConversionBatch: vi.fn(async () => ({
      batch: conversionBatch({
        id: BATCH_ID,
        state: 'started',
        startedAt: '2026-10-29T10:00:00.000Z',
        watch,
      }),
      items,
    })),
  });
}
const documents = () => within(screen.getByRole('table', { name: 'Documents' }));
const panel = () => within(screen.getByRole('complementary', { name: 'Document' }));

describe('a watched folder batch', () => {
  it('hides re-run, force-load, redeliver and load-as-new, but keeps detach', async () => {
    const api = batchApi(
      [
        item('changed.docx', 'changed_in_target', { registerEntryId: 'e1', reloadable: true }),
        item('bad.docx', 'failed'),
        item('dup.docx', 'duplicate'),
      ],
      WATCH,
    );
    render(<ConversionPage api={api} batchId={BATCH_ID} />);
    expect(await screen.findByText('Watched: Inbox')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Re-run/ })).toBeNull();

    await userEvent.click(documents().getByRole('button', { name: 'changed.docx' }));
    expect(panel().getByRole('button', { name: 'Detach changed.docx' })).toBeInTheDocument();
    expect(panel().queryByRole('button', { name: /^Redeliver/ })).toBeNull();
    expect(panel().queryByRole('button', { name: /as a new document/ })).toBeNull();

    await userEvent.click(documents().getByRole('button', { name: 'bad.docx' }));
    expect(panel().queryByRole('button', { name: /Re-run/ })).toBeNull();

    await userEvent.click(documents().getByRole('button', { name: 'dup.docx' }));
    expect(panel().queryByRole('button', { name: /^Force-load/ })).toBeNull();

    await userEvent.click(documents().getByRole('button', { name: 'Actions for bad.docx' }));
    const menu = within(screen.getByRole('menu', { name: 'Actions for bad.docx' }));
    expect(menu.queryByRole('menuitem', { name: 'Re-run' })).toBeNull();
    expect(menu.getByRole('menuitem', { name: 'View report' })).toBeInTheDocument();
  });

  it('offers no download of a file refused unread', async () => {
    const api = batchApi([item('refused.docx', 'failed', { objectKey: null })], WATCH);
    render(<ConversionPage api={api} batchId={BATCH_ID} />);
    await screen.findByRole('table', { name: 'Documents' });
    await userEvent.click(documents().getByRole('button', { name: 'refused.docx' }));
    expect(panel().queryByRole('link', { name: 'Download original' })).toBeNull();
    await userEvent.click(documents().getByRole('button', { name: 'Actions for refused.docx' }));
    expect(screen.queryByRole('menuitem', { name: 'Download original' })).toBeNull();
  });

  it('still downloads a stored original', async () => {
    const api = batchApi([item('ok.docx', 'created')], WATCH);
    render(<ConversionPage api={api} batchId={BATCH_ID} />);
    await screen.findByRole('table', { name: 'Documents' });
    await userEvent.click(documents().getByRole('button', { name: 'ok.docx' }));
    expect(panel().getByRole('link', { name: 'Download original' })).toBeInTheDocument();
  });

  it('tags the watch in the earlier batches', async () => {
    const api = fakeApi({
      listConversionTargets: vi.fn(async () => TARGETS),
      listConversionBatches: vi.fn(async () => [
        {
          ...conversionBatch({
            state: 'started',
            startedAt: '2026-10-29T10:00:00.000Z',
            watch: WATCH,
          }),
          itemCount: 0,
          counts: {} as never,
        },
      ]),
    });
    render(<ConversionPage api={api} />);
    expect(await screen.findByText('Watched: Inbox')).toBeInTheDocument();
  });

  it('keeps the actions on an ordinary batch', async () => {
    const api = batchApi([item('bad.docx', 'failed')], null);
    render(<ConversionPage api={api} batchId={BATCH_ID} />);
    expect(await screen.findByRole('button', { name: 'Re-run Failures' })).toBeInTheDocument();
    expect(screen.queryByText(/Watched:/)).toBeNull();
  });
});
