import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SampleText } from '../src/workbench/SampleText.js';
import { SamplesTab } from '../src/workbench/SamplesTab.js';
import { fakeApi, sampleView } from './fake-api.js';

const tab = (api = fakeApi()) =>
  render(<SamplesTab api={api} projectId="letter" pollMs={60_000} />);
const row = (filename: string) => screen.getByRole('listitem', { name: filename });
const triage = (pageCount: number, ocrPages: number[]) => ({
  sha256: 'abc',
  pageCount,
  ocrPages,
  chars: 1412,
  ocrModel: 'local/olmocr',
});

describe('SamplesTab', () => {
  it('summarises readiness, capacity and OCR pages', async () => {
    tab(
      fakeApi({
        listSamples: vi.fn(async () => [
          sampleView({ filename: 'a.pdf', triage: triage(2, []) }),
          sampleView({ filename: 'b.pdf', triage: triage(3, [1, 2, 3]) }),
          sampleView({ filename: 'c.pdf', state: 'preparing', triage: null }),
          sampleView({ filename: 'h.pdf', role: 'holdout', triage: triage(1, []) }),
        ]),
      }),
    );
    const dev = await screen.findByRole('region', { name: 'Dev samples' });
    expect(dev).toHaveTextContent('2ready of 3');
    expect(dev).toHaveTextContent('3–8 recommended');
    expect(screen.getByRole('region', { name: 'Holdout samples' })).toHaveTextContent(
      'Add 1 more for the publish gate (≥ 2)',
    );
    expect(screen.getByRole('region', { name: 'Capacity' })).toHaveTextContent('8 slots left');
    expect(screen.getByRole('region', { name: 'OCR' })).toHaveTextContent('3of 6 pages');
    expect(screen.getByRole('img', { name: 'Dev samples ready: 67%' })).toBeInTheDocument();
  });

  it('lists dev then holdout samples with status, meta and notes', async () => {
    tab(
      fakeApi({
        listSamples: vi.fn(async () => [
          sampleView({ filename: 'h.pdf', role: 'holdout', holdoutRuns: 3, triage: triage(2, []) }),
          sampleView({
            filename: 'scan.pdf',
            triage: triage(3, [1, 2, 3]),
            sizeBytes: 1.2 * 1024 * 1024,
          }),
          sampleView({
            filename: 'wip.pdf',
            state: 'preparing',
            triage: null,
            prepare: { stage: 'ocr', page: 1, of: 3 },
          }),
          sampleView({
            filename: 'locked.pdf',
            state: 'failed',
            triage: null,
            error: 'PDF is password-protected',
            prepareError: { code: 'password', message: 'PDF is password-protected' },
          }),
        ]),
      }),
    );
    const devList = await screen.findByRole('list', { name: 'Dev samples' });
    expect(
      within(devList)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('aria-label')),
    ).toEqual(['scan.pdf', 'wip.pdf', 'locked.pdf']);
    expect(row('scan.pdf')).toHaveTextContent('Ready');
    expect(row('scan.pdf')).toHaveTextContent('3 pages · 3 OCR · 1.2 MB · added for v1');
    expect(row('scan.pdf')).toHaveTextContent('Scanned — all 3 pages read by OCR (local/olmocr)');
    expect(within(row('scan.pdf')).getByLabelText('3 pages')).toHaveTextContent('3');
    expect(row('wip.pdf')).toHaveTextContent('Preparing — OCR page 2 of 3');
    expect(within(row('wip.pdf')).getByLabelText('Pages unknown')).toHaveTextContent('?');
    expect(row('locked.pdf')).toHaveTextContent('Failed');
    expect(row('locked.pdf')).toHaveTextContent(
      'PDF is password-protected. Remove the password and upload it again.',
    );
    const holdout = screen.getByRole('list', { name: 'Holdout samples' });
    expect(within(holdout).getByRole('listitem', { name: 'h.pdf' })).toHaveTextContent(
      'Used in 3 holdout evaluations · never sent to a model',
    );
    expect(row('scan.pdf')).not.toHaveTextContent('holdout evaluation');
  });

  it('says "1 holdout evaluation" in the singular', async () => {
    tab(
      fakeApi({
        listSamples: vi.fn(async () => [
          sampleView({ filename: 'h.pdf', role: 'holdout', holdoutRuns: 1 }),
        ]),
      }),
    );
    expect(await screen.findByRole('listitem', { name: 'h.pdf' })).toHaveTextContent(
      /Used in 1 holdout evaluation(?!s)/,
    );
  });

  it('uploads each chosen file with the Add as role and reports failures', async () => {
    const uploadSample = vi
      .fn()
      .mockResolvedValueOnce(sampleView())
      .mockRejectedValueOnce(new Error('this PDF is already a sample of the project'))
      .mockResolvedValue(sampleView());
    const api = fakeApi({ uploadSample });
    tab(api);
    const files = [
      new File(['%PDF-1'], 'one.pdf', { type: 'application/pdf' }),
      new File(['%PDF-2'], 'two.pdf', { type: 'application/pdf' }),
    ];
    await userEvent.upload(await screen.findByLabelText('Add sample documents'), files);
    expect(uploadSample).toHaveBeenCalledWith('letter', files[0], 'dev');
    expect(uploadSample).toHaveBeenCalledWith('letter', files[1], 'dev');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'two.pdf: this PDF is already a sample of the project',
    );

    const addAs = screen.getByRole('group', { name: 'Add as' });
    await userEvent.click(within(addAs).getByRole('button', { name: 'Holdout' }));
    expect(within(addAs).getByRole('button', { name: 'Holdout' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const three = new File(['%PDF-3'], 'three.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('Add sample documents'), three);
    expect(uploadSample).toHaveBeenLastCalledWith('letter', three, 'holdout');
  });

  it('uploads Word documents too', async () => {
    const uploadSample = vi.fn().mockResolvedValue(sampleView());
    tab(fakeApi({ uploadSample }));
    const word = new File(['PK'], 'letter.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await userEvent.upload(await screen.findByLabelText('Add sample documents'), word);
    expect(uploadSample).toHaveBeenCalledWith('letter', word, 'dev');
  });

  it('takes dropped files and skips what is not a PDF or Word document', async () => {
    const uploadSample = vi.fn().mockResolvedValue(sampleView());
    tab(fakeApi({ uploadSample }));
    const zone = (await screen.findByText(/Drop sample files here/)).closest('.drop-zone')!;
    const pdf = new File(['%PDF-1'], 'one.pdf', { type: 'application/pdf' });
    const txt = new File(['hi'], 'notes.txt', { type: 'text/plain' });
    fireEvent.drop(zone, { dataTransfer: { files: [pdf, txt] } });
    await waitFor(() => expect(uploadSample).toHaveBeenCalledWith('letter', pdf, 'dev'));
    expect(uploadSample).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'notes.txt: not a PDF or Word document',
    );
  });

  it('tells the page after a successful upload, role change or removal, not after a failed upload', async () => {
    const good = sampleView({ filename: 'good.pdf' });
    const uploadSample = vi
      .fn()
      .mockRejectedValueOnce(new Error('this PDF is already a sample of the project'))
      .mockResolvedValue(sampleView());
    const api = fakeApi({
      listSamples: vi.fn(async () => [good]),
      uploadSample,
      setSampleRole: vi.fn(async () => ({ ...good, role: 'holdout' as const })),
    });
    const onChanged = vi.fn();
    render(<SamplesTab api={api} projectId="letter" pollMs={60_000} onChanged={onChanged} />);
    await screen.findByRole('listitem', { name: 'good.pdf' });
    const file = new File(['%PDF-1'], 'one.pdf', { type: 'application/pdf' });

    await userEvent.upload(screen.getByLabelText('Add sample documents'), file);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();

    await userEvent.upload(screen.getByLabelText('Add sample documents'), file);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    const role = within(row('good.pdf')).getByRole('group', { name: 'Role of good.pdf' });
    await userEvent.click(within(role).getByRole('button', { name: 'Holdout' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));

    await userEvent.click(within(row('good.pdf')).getByRole('button', { name: 'Remove good.pdf' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(3));
  });

  it('changes a role, retries a failed preparation and removes a sample', async () => {
    const failed = sampleView({
      filename: 'bad.pdf',
      state: 'failed',
      error: 'OCR down',
      triage: null,
    });
    const good = sampleView({ filename: 'good.pdf' });
    const api = fakeApi({
      listSamples: vi.fn(async () => [good, failed]),
      setSampleRole: vi.fn(async () => ({ ...good, role: 'holdout' as const })),
    });
    tab(api);
    expect(await screen.findByRole('listitem', { name: 'bad.pdf' })).toHaveTextContent(
      'Could not prepare it: OCR down',
    );
    const role = within(row('good.pdf')).getByRole('group', { name: 'Role of good.pdf' });
    expect(within(role).getByRole('button', { name: 'Dev' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(within(role).getByRole('button', { name: 'Dev' }));
    expect(api.setSampleRole).not.toHaveBeenCalled(); // already dev
    await userEvent.click(within(role).getByRole('button', { name: 'Holdout' }));
    expect(api.setSampleRole).toHaveBeenCalledWith('letter', good.id, 'holdout');

    expect(within(row('good.pdf')).queryByRole('button', { name: /Retry/ })).toBeNull();
    await userEvent.click(within(row('bad.pdf')).getByRole('button', { name: 'Retry bad.pdf' }));
    expect(api.retryJob).toHaveBeenCalledWith(failed.prepareJobId);

    await userEvent.click(within(row('good.pdf')).getByRole('button', { name: 'Remove good.pdf' }));
    expect(api.removeSample).toHaveBeenCalledWith('letter', good.id);
  });

  it('previews the first ready dev sample, page by page, and switches on selection', async () => {
    const a = sampleView({ filename: 'a.pdf', triage: triage(2, [2]) });
    const b = sampleView({ filename: 'b.pdf', triage: triage(1, []) });
    const wip = sampleView({ filename: 'wip.pdf', state: 'preparing', triage: null });
    const getSampleText = vi.fn(async (_p: string, id: string) => ({
      sha256: 'abc',
      pages:
        id === a.id
          ? [
              { number: 1, text: 'PROTOCOL APPROVAL', ocr: false },
              { number: 2, text: 'Batch 1 results', ocr: true },
            ]
          : [{ number: 1, text: 'MEMO', ocr: false }],
    }));
    tab(fakeApi({ listSamples: vi.fn(async () => [wip, a, b]), getSampleText }));
    const preview = await screen.findByRole('region', { name: 'Text preview' });
    expect(within(preview).getByRole('heading', { name: 'a.pdf' })).toBeInTheDocument();
    expect(preview).toHaveTextContent('1,412 characters');
    expect(await within(preview).findByRole('region', { name: 'Page 1' })).toHaveTextContent(
      '[page 1] PROTOCOL APPROVAL',
    );
    await userEvent.click(within(preview).getByRole('button', { name: 'Page 2 OCR' }));
    expect(within(preview).getByRole('region', { name: 'Page 2' })).toHaveTextContent(
      'Batch 1 results',
    );
    expect(preview).toHaveTextContent('Read by OCR (local/olmocr) · cached per PDF hash');
    expect(screen.getByRole('button', { name: 'Show text of a.pdf' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Show text of wip.pdf' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Show text of b.pdf' }));
    expect(await within(preview).findByText(/MEMO/)).toBeInTheDocument();
    expect(getSampleText).toHaveBeenLastCalledWith('letter', b.id);
  });

  it('marks where a section starts on its page', async () => {
    const api = fakeApi({
      getSampleText: vi.fn(async () => ({
        sha256: 'abc',
        pages: [
          { number: 1, text: 'intro\nTOTALS\n13.00', ocr: false },
          { number: 2, text: 'TOTALS again', ocr: false },
        ],
      })),
    });
    render(
      <SampleText
        api={api}
        projectId="letter"
        sampleId="s1"
        marks={[{ page: 1, line: 'TOTALS', label: 'totals' }]}
      />,
    );
    const note = await screen.findByRole('note', { name: 'totals starts here' });
    expect(screen.getByRole('region', { name: 'Page 1' })).toContainElement(note);
    expect(screen.getByRole('region', { name: 'Page 2' })).not.toContainElement(note);
  });

  it('places a mark whose line is a page marker before the first line of the page', async () => {
    const api = fakeApi({
      getSampleText: vi.fn(async () => ({
        sha256: 'abc',
        pages: [{ number: 1, text: 'intro\nbody', ocr: false }],
      })),
    });
    render(
      <SampleText
        api={api}
        projectId="letter"
        sampleId="s1"
        marks={[{ page: 1, line: '[page 1]', label: 'all' }]}
      />,
    );
    const note = await screen.findByRole('note', { name: 'all starts here' });
    const pre = note.closest('pre')!;
    expect(pre.textContent).toMatch(/^▶ all\nintro/);
  });

  it('matches a truncated start line by prefix', async () => {
    const long = 'LONG HEADER '.repeat(30);
    const api = fakeApi({
      getSampleText: vi.fn(async () => ({
        sha256: 'abc',
        pages: [{ number: 1, text: `intro\n${long}\nbody`, ocr: false }],
      })),
    });
    render(
      <SampleText
        api={api}
        projectId="letter"
        sampleId="s1"
        marks={[{ page: 1, line: long.slice(0, 200), label: 'head' }]}
      />,
    );
    expect(await screen.findByRole('note', { name: 'head starts here' })).toBeInTheDocument();
  });
});

describe('SamplesTab capacity and polling', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => sampleView({ filename: `s${i}.pdf` }));
  const pdf = (name: string) => new File(['%PDF-1'], name, { type: 'application/pdf' });

  it('caps a dropped batch to the slots left and ignores drops at capacity', async () => {
    const uploadSample = vi.fn().mockResolvedValue(sampleView());
    const listSamples = vi.fn(async () => many(11));
    tab(fakeApi({ listSamples, uploadSample }));
    const zone = (await screen.findByText(/Drop sample files here/)).closest('.drop-zone')!;
    fireEvent.drop(zone, { dataTransfer: { files: [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')] } });
    await waitFor(() => expect(uploadSample).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toHaveTextContent('b.pdf: no sample slots left');
  });

  it('uploads nothing and disables the picker with no slots left', async () => {
    const uploadSample = vi.fn().mockResolvedValue(sampleView());
    tab(fakeApi({ listSamples: vi.fn(async () => many(12)), uploadSample }));
    const zone = (await screen.findByText(/Drop sample files here/)).closest('.drop-zone')!;
    expect(screen.getByLabelText('Add sample documents')).toBeDisabled();
    fireEvent.drop(zone, { dataTransfer: { files: [pdf('a.pdf')] } });
    expect(uploadSample).not.toHaveBeenCalled();
  });

  it('polls while a sample is preparing, stops when all are ready and after unmount', async () => {
    vi.useFakeTimers();
    try {
      let state: 'preparing' | 'ready' = 'preparing';
      const listSamples = vi.fn(async () => [
        sampleView({ filename: 'w.pdf', state, triage: state === 'ready' ? triage(1, []) : null }),
      ]);
      const view = render(
        <SamplesTab api={fakeApi({ listSamples })} projectId="letter" pollMs={100} />,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(listSamples).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(listSamples).toHaveBeenCalledTimes(2);
      state = 'ready';
      await vi.advanceTimersByTimeAsync(100);
      expect(listSamples).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(500);
      expect(listSamples).toHaveBeenCalledTimes(3);

      state = 'preparing';
      view.unmount();
      await vi.advanceTimersByTimeAsync(500);
      expect(listSamples).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a list error once a later refresh succeeds', async () => {
    vi.useFakeTimers();
    try {
      const listSamples = vi
        .fn()
        .mockResolvedValueOnce([
          sampleView({ filename: 'w.pdf', state: 'preparing', triage: null }),
        ])
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValue([sampleView({ filename: 'w.pdf', state: 'preparing', triage: null })]);
      render(<SamplesTab api={fakeApi({ listSamples })} projectId="letter" pollMs={100} />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(screen.getByRole('alert')).toHaveTextContent('network down');
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
