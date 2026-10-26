import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '@ih/shared';
import { App } from '../src/App.js';
import { ApiError } from '../src/api/client.js';
import { ConversionPage } from '../src/conversion/ConversionPage.js';
import { droppedFolder, droppedItems } from './drop-fakes.js';
import { ADMIN_ME, conversionBatch, conversionItem, fakeApi } from './fake-api.js';

const BATCH_ID = '6f1c2a10-4b7e-4c55-9d2a-0c8e7b3f5a11';
const TARGETS = [
  { id: 'documents', label: 'Controlled documents', sinkName: 'Document sink' },
  { id: 'archive', label: 'Archive', sinkName: 'Document sink' },
];
/** The batch's start button: "Convert N documents" ("Convert documents" with none ready). */
const CONVERT = /^Convert( \d+)? documents?$/;
const OPERATOR = { ...ADMIN_ME, role: 'operator' as const, label: 'Olu', email: 'olu@example.com' };

const word = (name: string) => new File(['PK'], name); // browsers often send no type for .docx
function inFolder(path: string): File {
  const file = new File(['PK'], path.split('/').pop()!);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

/** The API answering a batch as it would: an open batch, each upload an item, start started. */
function conversionApi(overrides: Parameters<typeof fakeApi>[0] = {}) {
  return fakeApi({
    listConversionTargets: vi.fn(async () => TARGETS),
    createConversionBatch: vi.fn(async (body) =>
      conversionBatch({ id: BATCH_ID, targetId: body.targetId, force: body.force ?? false }),
    ),
    uploadConversionItem: vi.fn(async (batchId, file, sourceKey) =>
      conversionItem({ batchId, filename: file.name, sourceKey }),
    ),
    startConversionBatch: vi.fn(async (batchId) =>
      conversionBatch({ id: batchId, state: 'started', startedAt: '2026-10-25T10:01:00.000Z' }),
    ),
    discardConversionBatch: vi.fn(async () => undefined),
    ...overrides,
  });
}

const listed = () =>
  within(screen.getByRole('list', { name: 'Files to convert' }))
    .getAllByRole('listitem')
    .map((li) => li.querySelector('.mono')?.textContent);

describe('the Conversion tab: a new batch', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('offers only targets that take documents', async () => {
    const api = conversionApi();
    render(<ConversionPage api={api} />);
    const target = await screen.findByRole('combobox', { name: 'Target' });
    await waitFor(() => expect(within(target).getAllByRole('option')).toHaveLength(2));
    expect(
      within(target)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Controlled documents · Document sink', 'Archive · Document sink']);
    expect(api.listConversionTargets).toHaveBeenCalled();
    expect(api.listPublishTargetChoices).not.toHaveBeenCalled();
  });

  it('says so when no target takes documents', async () => {
    render(
      <ConversionPage api={conversionApi({ listConversionTargets: vi.fn(async () => []) })} />,
    );
    expect(await screen.findByText(/No target takes Word documents yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: CONVERT })).toBeDisabled();
  });

  it('a single file becomes a batch of one', async () => {
    const api = conversionApi();
    render(<ConversionPage api={api} />);
    await screen.findByRole('option', { name: 'Archive · Document sink' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Target' }), 'archive');
    const report = word('report.docx');
    await userEvent.upload(screen.getByLabelText('Choose files'), report);
    expect(listed()).toEqual(['report.docx']);
    await userEvent.click(screen.getByRole('button', { name: CONVERT }));
    await waitFor(() => expect(api.startConversionBatch).toHaveBeenCalledWith(BATCH_ID));
    expect(api.createConversionBatch).toHaveBeenCalledWith({ targetId: 'archive', force: false });
    expect(api.uploadConversionItem).toHaveBeenCalledTimes(1);
    expect(api.uploadConversionItem).toHaveBeenCalledWith(
      BATCH_ID,
      report,
      'report.docx',
      expect.any(Function),
    );
  });

  it('sends force-load with the batch', async () => {
    const api = conversionApi();
    render(<ConversionPage api={api} />);
    await screen.findByRole('option', { name: 'Archive · Document sink' });
    await userEvent.upload(screen.getByLabelText('Choose files'), word('report.docx'));
    await userEvent.click(screen.getByRole('switch', { name: 'Force-load' }));
    await userEvent.click(screen.getByRole('button', { name: CONVERT }));
    await waitFor(() =>
      expect(api.createConversionBatch).toHaveBeenCalledWith({
        targetId: 'documents',
        force: true,
      }),
    );
  });

  it("a folder keeps each file's relative path as its source key", async () => {
    const api = conversionApi();
    render(<ConversionPage api={api} />);
    await screen.findByRole('option', { name: 'Archive · Document sink' });
    const files = [inFolder('Policies/sub/b.docx'), inFolder('Policies/a.docx')];
    await userEvent.upload(screen.getByLabelText('Choose folder'), files);
    expect(listed()).toEqual(['Policies/a.docx', 'Policies/sub/b.docx']);
    await userEvent.click(screen.getByRole('button', { name: CONVERT }));
    await waitFor(() => expect(api.startConversionBatch).toHaveBeenCalled());
    expect(vi.mocked(api.uploadConversionItem).mock.calls.map((c) => c[2])).toEqual([
      'Policies/a.docx',
      'Policies/sub/b.docx',
    ]);
  });

  it("a dropped folder keeps each file's path in the folder as its source key", async () => {
    render(<ConversionPage api={conversionApi()} />);
    await screen.findByRole('option', { name: 'Archive · Document sink' });
    const folder = droppedFolder('Policies', [word('a.docx'), ['sub', [word('b.docx')]]]);
    fireEvent.drop(screen.getByText(/Drop Word files or a folder here/).closest('.drop-zone')!, {
      dataTransfer: droppedItems([word('loose.docx'), folder]),
    });
    await waitFor(() =>
      expect(listed()).toEqual(['loose.docx', 'Policies/a.docx', 'Policies/sub/b.docx']),
    );
  });

  it('skips lock and hidden files', async () => {
    render(<ConversionPage api={conversionApi()} />);
    await screen.findByRole('option', { name: 'Archive · Document sink' });
    await userEvent.upload(screen.getByLabelText('Choose folder'), [
      inFolder('Policies/a.docx'),
      inFolder('Policies/~$a.docx'), // Word's lock file while a.docx is open
      inFolder('Policies/.hidden.docx'),
      inFolder('Policies/.git/b.docx'),
      inFolder('Policies/notes.pdf'),
    ]);
    expect(listed()).toEqual(['Policies/a.docx']);
    expect(screen.getByText(/4 files left out/)).toBeInTheDocument();
  });

  it('flags a source key the target cannot take and leaves that file out', async () => {
    const api = conversionApi();
    render(<ConversionPage api={api} />);
    await screen.findByRole('option', { name: 'Archive · Document sink' });
    await userEvent.upload(screen.getByLabelText('Choose files'), [
      word('a\\b.docx'),
      word('good.docx'),
    ]);
    const bad = screen.getByText('a\\b.docx').closest('li')!;
    expect(bad).toHaveTextContent('the source key holds a backslash');
    await userEvent.click(screen.getByRole('button', { name: CONVERT }));
    await waitFor(() => expect(api.startConversionBatch).toHaveBeenCalled());
    expect(vi.mocked(api.uploadConversionItem).mock.calls.map((c) => c[2])).toEqual(['good.docx']);
  });

  /** The row of each listed source key, in list order: [key, its message]. */
  const rowsOf = () =>
    within(screen.getByRole('list', { name: 'Files to convert' }))
      .getAllByRole('listitem')
      .map((li) => [li.querySelector('.mono')?.textContent, li.textContent]);

  it('a later pick of a source key already listed is flagged and never sent', async () => {
    const api = conversionApi();
    render(<ConversionPage api={api} />);
    await screen.findByRole('option', { name: 'Archive · Document sink' });
    const first = word('a.docx');
    await userEvent.upload(screen.getByLabelText('Choose files'), first);
    await userEvent.upload(screen.getByLabelText('Choose files'), word('a.docx'));
    const rows = rowsOf();
    expect(rows.map(([key]) => key)).toEqual(['a.docx', 'a.docx']);
    expect(rows[0]![1]).toContain('Ready');
    expect(rows[1]![1]).toContain('Already in the list');
    await userEvent.click(screen.getByRole('button', { name: CONVERT }));
    await waitFor(() => expect(api.startConversionBatch).toHaveBeenCalled());
    expect(api.uploadConversionItem).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.uploadConversionItem).mock.calls[0]![1]).toBe(first);
  });

  it('two loose files of the same name in one pick: the second is flagged', async () => {
    const api = conversionApi();
    render(<ConversionPage api={api} />);
    await screen.findByRole('option', { name: 'Archive · Document sink' });
    fireEvent.drop(screen.getByText(/Drop Word files or a folder here/).closest('.drop-zone')!, {
      dataTransfer: droppedItems([word('a.docx'), word('a.docx')]),
    });
    await waitFor(() => expect(rowsOf()).toHaveLength(2));
    expect(rowsOf()[0]![1]).toContain('Ready');
    expect(rowsOf()[1]![1]).toContain('Already in the list');
    await userEvent.click(screen.getByRole('button', { name: CONVERT }));
    await waitFor(() => expect(api.startConversionBatch).toHaveBeenCalled());
    expect(api.uploadConversionItem).toHaveBeenCalledTimes(1);
  });

  it('two dropped folders of the same name: the repeated paths are flagged', async () => {
    const api = conversionApi();
    render(<ConversionPage api={api} />);
    await screen.findByRole('option', { name: 'Archive · Document sink' });
    fireEvent.drop(screen.getByText(/Drop Word files or a folder here/).closest('.drop-zone')!, {
      dataTransfer: droppedItems([
        droppedFolder('Policies', [word('a.docx'), word('b.docx')]),
        droppedFolder('Policies', [word('a.docx')]),
      ]),
    });
    await waitFor(() => expect(rowsOf()).toHaveLength(3));
    expect(rowsOf().map(([key, text]) => [key, text?.includes('Already in the list')])).toEqual([
      ['Policies/a.docx', false],
      ['Policies/b.docx', false],
      ['Policies/a.docx', true],
    ]);
    await userEvent.click(screen.getByRole('button', { name: CONVERT }));
    await waitFor(() => expect(api.startConversionBatch).toHaveBeenCalled());
    expect(vi.mocked(api.uploadConversionItem).mock.calls.map((c) => c[2])).toEqual([
      'Policies/a.docx',
      'Policies/b.docx',
    ]);
  });

  it('a second Convert before the first renders opens no second batch', async () => {
    const api = conversionApi();
    render(<ConversionPage api={api} />);
    await screen.findByRole('option', { name: 'Archive · Document sink' });
    await userEvent.upload(screen.getByLabelText('Choose files'), word('a.docx'));
    const start = screen.getByRole('button', { name: CONVERT });
    act(() => {
      start.click();
      start.click();
    });
    await waitFor(() => expect(api.startConversionBatch).toHaveBeenCalled());
    expect(api.createConversionBatch).toHaveBeenCalledTimes(1);
    expect(api.uploadConversionItem).toHaveBeenCalledTimes(1);
  });

  it('lets the person remove a file from the list', async () => {
    render(<ConversionPage api={conversionApi()} />);
    await screen.findByRole('option', { name: 'Archive · Document sink' });
    await userEvent.upload(screen.getByLabelText('Choose files'), [word('a.docx'), word('b.docx')]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove a.docx' }));
    expect(listed()).toEqual(['b.docx']);
  });

  it('a refused file shows its reason and the others upload', async () => {
    const api = conversionApi({
      uploadConversionItem: vi.fn(async (batchId: string, file: File, sourceKey: string) => {
        if (file.name === 'old.docx') {
          throw new ApiError('the file is not a Word document', 415);
        }
        return conversionItem({ batchId, filename: file.name, sourceKey });
      }),
    });
    render(<ConversionPage api={api} />);
    await screen.findByRole('option', { name: 'Archive · Document sink' });
    await userEvent.upload(screen.getByLabelText('Choose files'), [
      word('a.docx'),
      word('old.docx'),
      word('c.docx'),
    ]);
    await userEvent.click(screen.getByRole('button', { name: CONVERT }));
    await waitFor(() => expect(api.startConversionBatch).toHaveBeenCalledWith(BATCH_ID));
    expect(api.uploadConversionItem).toHaveBeenCalledTimes(3);
    expect(screen.getByText('old.docx').closest('li')).toHaveTextContent(
      'the file is not a Word document',
    );
    expect(screen.getByText('c.docx').closest('li')).toHaveTextContent('Uploaded');
    // The reason stays in view: the batch view is one click away.
    expect(await screen.findByRole('link', { name: 'Open the batch' })).toHaveAttribute(
      'href',
      `#/conversion/${BATCH_ID}`,
    );
    expect(window.location.hash).not.toBe(`#/conversion/${BATCH_ID}`);
  });

  it('a batch whose every file is refused is discarded', async () => {
    const api = conversionApi({
      uploadConversionItem: vi.fn(async () => {
        throw new ApiError('the Word document has tracked changes', 422);
      }),
    });
    render(<ConversionPage api={api} />);
    await screen.findByRole('option', { name: 'Archive · Document sink' });
    await userEvent.upload(screen.getByLabelText('Choose files'), word('a.docx'));
    await userEvent.click(screen.getByRole('button', { name: CONVERT }));
    await waitFor(() => expect(api.discardConversionBatch).toHaveBeenCalledWith(BATCH_ID));
    expect(api.startConversionBatch).not.toHaveBeenCalled();
    expect(screen.getByText('a.docx').closest('li')).toHaveTextContent('tracked changes');
  });

  it('shows the upload progress, and cancel discards the open batch', async () => {
    let finish: () => void = () => undefined;
    const api = conversionApi({
      uploadConversionItem: vi.fn(
        (
          batchId: string,
          file: File,
          sourceKey: string,
          onProgress?: (s: number, t: number) => void,
        ) =>
          new Promise<Item>((resolve) => {
            onProgress?.(1, 2);
            finish = () => resolve(conversionItem({ batchId, filename: file.name, sourceKey }));
          }),
      ),
    });
    render(<ConversionPage api={api} />);
    await screen.findByRole('option', { name: 'Archive · Document sink' });
    await userEvent.upload(screen.getByLabelText('Choose files'), [word('a.docx'), word('b.docx')]);
    await userEvent.click(screen.getByRole('button', { name: CONVERT }));
    expect(await screen.findByRole('img', { name: 'Upload progress: 25%' })).toBeInTheDocument();
    expect(screen.getByText('Uploading 1 of 2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    finish();
    await waitFor(() => expect(api.discardConversionBatch).toHaveBeenCalledWith(BATCH_ID));
    expect(api.uploadConversionItem).toHaveBeenCalledTimes(1);
    expect(api.startConversionBatch).not.toHaveBeenCalled();
    expect(listed()).toEqual(['a.docx', 'b.docx']);
    expect(screen.getByRole('button', { name: CONVERT })).toBeEnabled();
  });

  it('converting opens the batch view', async () => {
    const api = conversionApi();
    render(<ConversionPage api={api} />);
    await screen.findByRole('option', { name: 'Archive · Document sink' });
    await userEvent.upload(screen.getByLabelText('Choose files'), word('report.docx'));
    await userEvent.click(screen.getByRole('button', { name: CONVERT }));
    await waitFor(() => expect(window.location.hash).toBe(`#/conversion/${BATCH_ID}`));
  });

  it('operators see the tab', async () => {
    window.location.hash = '#/conversion';
    const api = conversionApi({ me: vi.fn(async () => OPERATOR) });
    render(<App api={api} pollMs={0} />);
    const menu = within(await screen.findByRole('navigation', { name: 'Main' }));
    expect(menu.getByRole('link', { name: 'Conversion' })).toHaveAttribute('href', '#/conversion');
    expect(
      await screen.findByRole('heading', { name: 'Conversion', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Not available to operators' })).toBeNull();
  });
});
