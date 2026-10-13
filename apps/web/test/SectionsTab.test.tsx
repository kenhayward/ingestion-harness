import { render, screen, waitFor, within } from '@testing-library/react';
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

const supplierDefinition = {
  ...definition,
  document: {
    ...definition.document,
    sections: [
      { id: 'header', anchor: '^TAX INVOICE' },
      { id: 'supplier', anchor: '^(From|Supplier)\\b' },
    ],
  },
};
const missGrid = {
  anchorErrors: {},
  samples: [
    {
      sampleId: 's1',
      firstPage: 1,
      pageCount: 1,
      error: null,
      missingRequired: ['supplier'],
      sections: [
        { id: 'header', found: true, page: 1, line: 'TAX INVOICE', chars: 30 },
        { id: 'supplier', found: false, page: null, line: null, chars: 0 },
      ],
    },
  ],
  suggestions: [
    {
      section: 'supplier',
      sampleId: 's1',
      anchor: '^(From|Supplier|Vendor)\\b',
      reason: 'This sample labels it "Vendor:"; no alternative of the anchor matches that.',
    },
  ],
};
const missSetup = () =>
  setup({
    getTemplate: vi.fn(async () => templateView(supplierDefinition)),
    getSegmentation: vi.fn(async () => segmentationView({ jobId: 'j1', result: missGrid })),
    getSampleText: vi.fn(async () => ({
      sha256: 'abc',
      pages: [{ number: 1, text: 'TAX INVOICE\nVendor: Globex', ocr: false }],
    })),
  });

function setup(overrides = {}, onDirtyChange?: (dirty: boolean) => void) {
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
  render(
    <SectionsTab
      api={api}
      projectId="letter"
      draft={2}
      pollMs={1}
      {...(onDirtyChange ? { onDirtyChange } : {})}
    />,
  );
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
    await userEvent.click(screen.getByRole('button', { name: 'Save to draft v2' }));
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
    const api = setup();
    await screen.findByRole('button', { name: 'a.pdf · all' });
    await userEvent.click(screen.getByRole('button', { name: 'Add section' }));
    await userEvent.type(screen.getByLabelText('Id of section 2'), 'all');
    await userEvent.type(screen.getByLabelText('Anchor of section 2'), '^Total');
    expect(screen.getByRole('button', { name: 'Save to draft v2' })).toBeDisabled();
    expect(api.startSegmentation).toHaveBeenCalledTimes(1); // only the load: an id clash is never previewed
  });

  it('removes copies from the saved definition when the copy anchor is cleared', async () => {
    const api = setup();
    await screen.findByRole('button', { name: 'a.pdf · all' });
    await userEvent.click(screen.getByText(/^Document options/));
    await userEvent.clear(screen.getByLabelText('Copy anchor'));
    const save = screen.getByRole('button', { name: 'Save to draft v2' });
    await waitFor(() => expect(save).toBeEnabled(), { timeout: 2000 });
    await userEvent.click(save);
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
    const save = screen.getByRole('button', { name: 'Save to draft v2' });
    await waitFor(() => expect(save).toBeEnabled(), { timeout: 2000 });
    await userEvent.click(save);
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
    expect(screen.getByRole('button', { name: 'Save to draft v2' })).toBeDisabled();
    expect(screen.getByText(/Fix the slow anchor/)).toBeInTheDocument();

    api.startSegmentation = vi.fn(async () => segmentationView({ jobId: 'j3', status: 'queued' }));
    await userEvent.type(screen.getByLabelText('Anchor of section 1'), '?');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save to draft v2' })).toBeEnabled(),
    );
  });

  it('blocks saving while the preview reports an invalid anchor', async () => {
    const bad = { ...grid, anchorErrors: { all: 'missing ), unterminated subpattern' } };
    setup({ getSegmentation: vi.fn(async () => segmentationView({ jobId: 'j1', result: bad })) });
    await screen.findByRole('button', { name: 'a.pdf · all' });
    await userEvent.type(screen.getByLabelText('Anchor of section 1'), 'x');
    expect(screen.getByRole('button', { name: 'Save to draft v2' })).toBeDisabled();
    expect(await screen.findByText(/Fix the invalid anchor to save/)).toBeInTheDocument();
  });

  it('keeps Save disabled until the pending preview has finished', async () => {
    const api = setup();
    await screen.findByRole('button', { name: 'a.pdf · all' });
    await userEvent.type(screen.getByLabelText('Anchor of section 1'), 'x');
    expect(screen.getByRole('button', { name: 'Save to draft v2' })).toBeDisabled();
    await waitFor(() => expect(api.startSegmentation).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save to draft v2' })).toBeEnabled(),
    );
  });

  it('keeps the selection when the selected section is renamed', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'a.pdf · all' }));
    await userEvent.type(screen.getByLabelText('Id of section 1'), 'x');
    expect(screen.getByRole('button', { name: 'a.pdf · allx' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('asks for a draft when every version is published', () => {
    render(<SectionsTab api={fakeApi()} projectId="letter" draft={null} pollMs={1} />);
    expect(screen.getByText(/Start the next version on the Recipe tab/)).toBeInTheDocument();
  });

  it('shows hits per anchor and where it lands in the selected sample', async () => {
    missSetup();
    expect(await screen.findByRole('img', { name: 'Matched in 0 of 1 samples' })).toHaveTextContent(
      '0/1',
    );
    expect(screen.getByRole('img', { name: 'Matched in 1 of 1 samples' })).toHaveTextContent('1/1');
    expect(await screen.findByText('In a.pdf: no match — required')).toBeInTheDocument();
    expect(screen.getByText('In a.pdf: p.1 · matches "TAX INVOICE"')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'a.pdf · supplier' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('applies the suggested anchor in one click and previews it without saving', async () => {
    const api = missSetup();
    const hint = await screen.findByRole('note', { name: 'supplier not found' });
    expect(hint).toHaveTextContent('This sample labels it "Vendor:"');
    await userEvent.click(
      within(hint).getByRole('button', { name: 'Use ^(From|Supplier|Vendor)\\b' }),
    );
    expect(screen.getByLabelText('Anchor of section 2')).toHaveValue('^(From|Supplier|Vendor)\\b');
    await waitFor(
      () =>
        expect(api.startSegmentation).toHaveBeenLastCalledWith('letter', {
          sections: [
            { id: 'header', anchor: '^TAX INVOICE', required: true },
            { id: 'supplier', anchor: '^(From|Supplier|Vendor)\\b', required: true },
          ],
          pageMarkers: true,
          copies: { anchor: '^COPY', select: 'last' },
        }),
      { timeout: 2000 },
    );
    expect(api.saveTemplate).not.toHaveBeenCalled();
    expect(screen.getByText('Unsaved anchors')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save to draft v2' })).toBeEnabled(),
    );
  });

  it('selects a sample and section from a grid cell', async () => {
    missSetup();
    await userEvent.click(await screen.findByRole('button', { name: 'a.pdf · header' }));
    expect(screen.getByRole('button', { name: 'a.pdf · header' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByRole('note', { name: 'supplier not found' })).toBeNull();
    expect(await screen.findByRole('note', { name: 'header starts here' })).toBeInTheDocument();
  });

  it('moves a section and previews the new order', async () => {
    const api = missSetup();
    await screen.findByRole('button', { name: 'a.pdf · header' });
    await userEvent.click(screen.getByRole('button', { name: 'Move section 2 up' }));
    await waitFor(
      () =>
        expect(api.startSegmentation).toHaveBeenLastCalledWith(
          'letter',
          expect.objectContaining({
            sections: [
              { id: 'supplier', anchor: '^(From|Supplier)\\b', required: true },
              { id: 'header', anchor: '^TAX INVOICE', required: true },
            ],
          }),
        ),
      { timeout: 2000 },
    );
    expect(screen.getByRole('button', { name: 'Move section 1 up' })).toBeDisabled();
  });

  it('says why Save to draft is disabled', async () => {
    setup();
    await screen.findByRole('button', { name: 'a.pdf · all' });
    const save = screen.getByRole('button', { name: 'Save to draft v2' });
    expect(save).toHaveAttribute('title', 'No unsaved changes');
    await userEvent.type(screen.getByLabelText('Anchor of section 1'), 'x');
    expect(save).toHaveAttribute('title', 'Waiting for the preview');
    await userEvent.click(screen.getByRole('button', { name: 'Add section' }));
    expect(save).toHaveAttribute(
      'title',
      'Every section needs an id and an anchor; ids must differ',
    );
  });

  it('gives the slow-anchor reason as the Save title', async () => {
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
    await screen.findByRole('alert', {}, { timeout: 2000 });
    expect(screen.getByRole('button', { name: 'Save to draft v2' })).toHaveAttribute(
      'title',
      'Fix the slow anchor to save',
    );
  });

  it('hides the suggestion while a newer edit is waiting for its preview', async () => {
    missSetup();
    const hint = await screen.findByRole('note', { name: 'supplier not found' });
    expect(within(hint).getByRole('button', { name: /^Use / })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Anchor of section 2'), 'x');
    expect(
      within(screen.getByRole('note', { name: 'supplier not found' })).queryByRole('button', {
        name: /^Use /,
      }),
    ).toBeNull();
  });

  it('reports unsaved anchors to the page, and clears them after saving', async () => {
    const onDirtyChange = vi.fn();
    setup({}, onDirtyChange);
    await screen.findByRole('button', { name: 'a.pdf · all' });
    await userEvent.type(screen.getByLabelText('Anchor of section 1'), 'x');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    const save = screen.getByRole('button', { name: 'Save to draft v2' });
    await waitFor(() => expect(save).toBeEnabled(), { timeout: 2000 });
    await userEvent.click(save);
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });
});
