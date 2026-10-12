import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
});
