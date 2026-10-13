import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SectionsTab } from '../src/workbench/SectionsTab.js';
import { fakeApi, sampleView, segmentationView, templateView } from './fake-api.js';

const definition = {
  id: 'letter',
  version: 2,
  name: 'Letter',
  document: {
    ocr: 'auto',
    pageMarkers: true,
    copies: { anchor: '^COPY', select: 'last' },
    sections: [{ id: 'all', anchor: '\\A' }],
  },
  outputs: { fields: [] },
  pipeline: [],
};
const sample = sampleView({ id: 's1', filename: 'a.pdf' });
const grid = {
  anchorErrors: {},
  suggestions: [],
  samples: [
    {
      sampleId: 's1',
      firstPage: 1,
      pageCount: 1,
      error: null,
      missingRequired: [],
      sections: [{ id: 'all', found: true, page: 1, line: '[page 1]', chars: 40 }],
    },
  ],
};

function setup(overrides = {}) {
  const api = fakeApi({
    getTemplate: vi.fn(async () => templateView(definition)),
    saveTemplate: vi.fn(async (_id: string, _v: number, d: Record<string, unknown>) =>
      templateView(d),
    ),
    listSamples: vi.fn(async () => [sample]),
    startSegmentation: vi.fn(async () => segmentationView({ jobId: 'j1', status: 'queued' })),
    getSegmentation: vi.fn(async () => segmentationView({ jobId: 'j1', result: grid })),
    getSampleText: vi.fn(async () => ({
      sha256: 'abc',
      pages: [{ number: 1, text: 'intro\nHEADER\nbody', ocr: false }],
    })),
    ...overrides,
  });
  render(<SectionsTab api={api} projectId="letter" draft={2} pollMs={1} />);
  return api;
}

describe('SectionsTab', () => {
  it('previews the draft anchors on load', async () => {
    const api = setup();
    expect(await screen.findByRole('button', { name: 'a.pdf · all' })).toHaveTextContent(
      'p.1 · 40',
    );
    expect(api.startSegmentation).toHaveBeenCalledWith('letter', {
      sections: [{ id: 'all', anchor: '\\A', required: true }],
      pageMarkers: true,
      copies: { anchor: '^COPY', select: 'last' },
    });
  });

  it('previews edited anchors and saves them to the draft', async () => {
    const api = setup();
    await screen.findByRole('button', { name: 'a.pdf · all' });
    await userEvent.click(screen.getByRole('button', { name: 'Add section' }));
    await userEvent.type(screen.getByLabelText('Id of section 2'), 'totals');
    await userEvent.type(screen.getByLabelText('Anchor of section 2'), '^Total');
    await waitFor(
      () =>
        expect(api.startSegmentation).toHaveBeenLastCalledWith('letter', {
          sections: [
            { id: 'all', anchor: '\\A', required: true },
            { id: 'totals', anchor: '^Total', required: true },
          ],
          pageMarkers: true,
          copies: { anchor: '^COPY', select: 'last' },
        }),
      { timeout: 2000 },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save to draft' }));
    expect(api.saveTemplate).toHaveBeenCalledWith('letter', 2, {
      ...definition,
      document: {
        ...definition.document,
        sections: [
          { id: 'all', anchor: '\\A', required: true },
          { id: 'totals', anchor: '^Total', required: true },
        ],
      },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Saved to v2');
  });

  it('opens the sample text with the section start marked', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'a.pdf · all' }));
    expect(await screen.findByRole('note', { name: 'all starts here' })).toBeInTheDocument();
  });

  it('keeps Save disabled while two sections share an id', async () => {
    setup();
    await screen.findByRole('button', { name: 'a.pdf · all' });
    await userEvent.click(screen.getByRole('button', { name: 'Add section' }));
    await userEvent.type(screen.getByLabelText('Id of section 2'), 'all');
    await userEvent.type(screen.getByLabelText('Anchor of section 2'), '^Total');
    expect(screen.getByRole('button', { name: 'Save to draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
  });

  it('removes copies from the saved definition when the copy anchor is cleared', async () => {
    const api = setup();
    await screen.findByRole('button', { name: 'a.pdf · all' });
    await userEvent.clear(screen.getByLabelText('Copy anchor'));
    await userEvent.click(screen.getByRole('button', { name: 'Save to draft' }));
    const document: Record<string, unknown> = { ...definition.document };
    delete document.copies;
    expect(api.saveTemplate).toHaveBeenCalledWith('letter', 2, {
      ...definition,
      document: { ...document, sections: [{ id: 'all', anchor: '\\A', required: true }] },
    });
  });

  it('keeps a section description through an anchor edit and save', async () => {
    const described = {
      ...definition,
      document: {
        ...definition.document,
        sections: [{ id: 'all', anchor: '\\A', description: 'Cover page' }],
      },
    };
    const api = setup({ getTemplate: vi.fn(async () => templateView(described)) });
    await screen.findByRole('button', { name: 'a.pdf · all' });
    await userEvent.type(screen.getByLabelText('Anchor of section 1'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save to draft' }));
    expect(api.saveTemplate).toHaveBeenCalledWith('letter', 2, {
      ...described,
      document: {
        ...described.document,
        sections: [{ id: 'all', anchor: '\\Ax', required: true, description: 'Cover page' }],
      },
    });
  });

  it('blocks saving while the latest preview reports a catastrophic anchor', async () => {
    const api = setup();
    await screen.findByRole('button', { name: 'a.pdf · all' });
    api.startSegmentation = vi.fn(async () =>
      segmentationView({
        jobId: 'j2',
        status: 'needs_review',
        error: 'preview took longer than 10s; an anchor may backtrack catastrophically',
      }),
    );
    await userEvent.type(screen.getByLabelText('Anchor of section 1'), '+');
    expect(await screen.findByRole('alert', {}, { timeout: 2000 })).toHaveTextContent('backtrack');
    expect(screen.getByRole('button', { name: 'Save to draft' })).toBeDisabled();
    expect(screen.getByText(/Fix the slow anchor/)).toBeInTheDocument();

    api.startSegmentation = vi.fn(async () => segmentationView({ jobId: 'j3', status: 'queued' }));
    await userEvent.type(screen.getByLabelText('Anchor of section 1'), '?');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save to draft' })).toBeEnabled(),
    );
  });

  it('asks for a draft when every version is published', () => {
    render(<SectionsTab api={fakeApi()} projectId="letter" draft={null} pollMs={1} />);
    expect(screen.getByText(/Start the next version on the Template tab/)).toBeInTheDocument();
  });
});
