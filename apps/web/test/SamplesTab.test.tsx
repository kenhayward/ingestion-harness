import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SampleText } from '../src/workbench/SampleText.js';
import { SamplesTab } from '../src/workbench/SamplesTab.js';
import { fakeApi, sampleView } from './fake-api.js';

const tab = (api = fakeApi()) =>
  render(<SamplesTab api={api} projectId="letter" pollMs={60_000} />);
const row = (filename: string) => screen.getByRole('cell', { name: filename }).closest('tr')!;

describe('SamplesTab', () => {
  it('lists samples with triage and state', async () => {
    tab(
      fakeApi({
        listSamples: vi.fn(async () => [
          sampleView({ filename: 'a.pdf' }),
          sampleView({ filename: 'b.pdf', state: 'preparing', triage: null }),
        ]),
      }),
    );
    await screen.findByRole('table', { name: 'Samples' });
    expect(row('a.pdf')).toHaveTextContent('ready');
    expect(row('a.pdf')).toHaveTextContent('3'); // pages
    expect(row('b.pdf')).toHaveTextContent('preparing');
  });

  it('shows how often a holdout sample was used in evaluations', async () => {
    tab(
      fakeApi({
        listSamples: vi.fn(async () => [
          sampleView({ filename: 'h.pdf', role: 'holdout', holdoutRuns: 2 }),
          sampleView({ filename: 'd.pdf' }),
        ]),
      }),
    );
    await screen.findByRole('table', { name: 'Samples' });
    expect(row('h.pdf')).toHaveTextContent('used in 2 holdout evaluations');
    expect(row('d.pdf')).not.toHaveTextContent('holdout evaluation');
  });

  it('says "1 holdout evaluation" in the singular', async () => {
    tab(
      fakeApi({
        listSamples: vi.fn(async () => [
          sampleView({ filename: 'h.pdf', role: 'holdout', holdoutRuns: 1 }),
        ]),
      }),
    );
    await screen.findByRole('table', { name: 'Samples' });
    expect(row('h.pdf')).toHaveTextContent(/used in 1 holdout evaluation(?!s)/);
  });

  it('uploads each chosen PDF as a dev sample and reports failures', async () => {
    const uploadSample = vi
      .fn()
      .mockResolvedValueOnce(sampleView())
      .mockRejectedValueOnce(new Error('this PDF is already a sample of the project'));
    const api = fakeApi({ uploadSample });
    tab(api);
    const files = [
      new File(['%PDF-1'], 'one.pdf', { type: 'application/pdf' }),
      new File(['%PDF-2'], 'two.pdf', { type: 'application/pdf' }),
    ];
    await userEvent.upload(screen.getByLabelText('Add sample PDFs'), files);
    expect(uploadSample).toHaveBeenCalledWith('letter', files[0], 'dev');
    expect(uploadSample).toHaveBeenCalledWith('letter', files[1], 'dev');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'two.pdf: this PDF is already a sample of the project',
    );
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
    await screen.findByRole('table', { name: 'Samples' });
    expect(row('bad.pdf')).toHaveTextContent('OCR down');

    await userEvent.selectOptions(screen.getByLabelText('Role of good.pdf'), 'holdout');
    expect(api.setSampleRole).toHaveBeenCalledWith('letter', good.id, 'holdout');

    await userEvent.click(within(row('bad.pdf')).getByRole('button', { name: 'Retry bad.pdf' }));
    expect(api.retryJob).toHaveBeenCalledWith(failed.prepareJobId);

    await userEvent.click(within(row('good.pdf')).getByRole('button', { name: 'Remove good.pdf' }));
    expect(api.removeSample).toHaveBeenCalledWith('letter', good.id);
  });

  it('shows the prepared text page by page, marking OCR pages', async () => {
    const s = sampleView({ filename: 'a.pdf' });
    const api = fakeApi({
      listSamples: vi.fn(async () => [s]),
      getSampleText: vi.fn(async () => ({
        sha256: 'abc',
        pages: [
          { number: 1, text: 'PROTOCOL APPROVAL', ocr: false },
          { number: 2, text: 'Batch 1 results', ocr: true },
        ],
      })),
    });
    tab(api);
    await userEvent.click(await screen.findByRole('button', { name: 'View text of a.pdf' }));
    const page2 = await screen.findByRole('region', { name: 'Page 2' });
    expect(page2).toHaveTextContent('Batch 1 results');
    expect(page2).toHaveTextContent('OCR');
    expect(screen.getByRole('region', { name: 'Page 1' })).not.toHaveTextContent('OCR');
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
