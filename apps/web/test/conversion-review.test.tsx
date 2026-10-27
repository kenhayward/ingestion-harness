import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecomposedDocument } from '@ih/bridge-contract';
import type { ConversionReview } from '@ih/shared';
import { ApiError } from '../src/api/client.js';
import { ConversionReviewPage } from '../src/conversion/review/ConversionReviewPage.js';
import { conversionBatch, conversionItem, fakeApi } from './fake-api.js';

const BATCH_ID = '6f1c2a10-4b7e-4c55-9d2a-0c8e7b3f5a11';
const TARGETS = [{ id: 'documents', label: 'Controlled documents', sinkName: 'Document sink' }];

const text = (t: string) => [{ kind: 'text' as const, text: t, marks: [] }];
const cell = (t: string, o: { rowSpan?: number; header?: boolean } = {}) => ({
  rowSpan: o.rowSpan ?? 1,
  colSpan: 1,
  hAlign: 'left' as const,
  vAlign: 'top' as const,
  header: o.header ?? false,
  blocks: [{ kind: 'paragraph' as const, id: `p-${t}`, inlines: text(t) }],
});

/** Two sections: a paragraph and a table with a cell over two rows, then a figure. */
const DOCUMENT: DecomposedDocument = {
  blocks: [],
  sections: [
    {
      id: 's1',
      title: text('Introduction'),
      blocks: [
        { kind: 'paragraph', id: 'p1', inlines: text('The scope of the study.') },
        {
          kind: 'table',
          id: 't1',
          numbered: true,
          caption: text('Results by group'),
          captionPosition: 'above',
          columnWidths: [50, 50],
          headerRows: 0,
          rows: [
            { cells: [cell('Group A', { rowSpan: 2 }), cell('12.5')] },
            { cells: [cell('13.1')] },
          ],
          notes: [],
          wide: false,
          key: null,
        },
      ],
      sections: [],
    },
    {
      id: 's2',
      title: text('Results'),
      blocks: [
        {
          kind: 'figure',
          id: 'f1',
          imageId: 'img-chart',
          numbered: true,
          caption: text('A chart of the results'),
          captionPosition: 'below',
        },
      ],
      sections: [],
    },
  ],
  images: [
    {
      id: 'img-logo',
      contentType: 'image/png',
      widthMm: 10,
      heightMm: 10,
      align: 'center',
      alt: null,
      origin: 'cropped',
      originalContentType: null,
    },
    {
      id: 'img-chart',
      contentType: 'image/png',
      widthMm: 100,
      heightMm: 60,
      align: 'center',
      alt: null,
      origin: 'cropped',
      originalContentType: null,
    },
  ],
  equations: [],
  notes: [],
  properties: [],
  report: [
    { code: 'caption_not_found', severity: 'warning', at: 't1', message: 'No caption found' },
    {
      code: 'table_notes_unrecognised',
      severity: 'warning',
      at: 't1',
      message: 'Notes under the table were not recognised',
    },
    { code: 'caption_not_found', severity: 'warning', at: 'f1', message: 'No figure caption' },
  ],
};

const ITEM = conversionItem({
  batchId: BATCH_ID,
  sourceKey: 'reports/study.pdf',
  filename: 'study.pdf',
  outcome: 'awaiting_review',
  held: true,
  flagCount: 3,
});

const REVIEW: ConversionReview = {
  item: ITEM,
  document: DOCUMENT as unknown as Record<string, unknown>,
  pageCount: 3,
  // s2 has no pages of its own: its first block's page stands for it.
  pageMap: { s1: [1], p1: [1], t1: [2], f1: [3] },
  images: [
    { id: 'img-logo', contentType: 'image/png' },
    { id: 'img-chart', contentType: 'image/png' },
  ],
};

function reviewApi(overrides: Parameters<typeof fakeApi>[0] = {}) {
  return fakeApi({
    conversionReview: vi.fn(async () => REVIEW),
    getConversionBatch: vi.fn(async () => ({
      batch: conversionBatch({ id: BATCH_ID }),
      items: [ITEM],
    })),
    listConversionTargets: vi.fn(async () => TARGETS),
    ...overrides,
  });
}

async function view(api = reviewApi()) {
  render(<ConversionReviewPage api={api} itemId={ITEM.id} />);
  await screen.findByRole('heading', { level: 1, name: 'study.pdf' });
  return api;
}

const shownPage = () =>
  within(screen.getByRole('region', { name: 'Source PDF' })).getByRole('img', {
    name: /^Page \d of 3$/,
  });
const outline = () => within(screen.getByRole('navigation', { name: 'Outline' }));
const notAwaiting = () =>
  new ApiError('item is not awaiting review', 409, { code: 'NOT_AWAITING_REVIEW' });

describe('ConversionReviewPage', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('lists the headings and draws a table with its merged cells', async () => {
    await view();
    expect(outline().getByRole('button', { name: /^Introduction/ })).toBeInTheDocument();
    expect(outline().getByRole('button', { name: /^Results/ })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Group A' })).toHaveAttribute('rowspan', '2');
    expect(screen.getByRole('table', { name: /Results by group/ })).toBeInTheDocument();
  });

  it('shows a figure as its crop, by the image position in the review', async () => {
    await view();
    expect(screen.getByRole('img', { name: 'A chart of the results' })).toHaveAttribute(
      'src',
      `/api/conversions/items/${ITEM.id}/images/1`,
    );
  });

  it('marks flagged pages, and a flag shows its page', async () => {
    await view();
    expect(shownPage()).toHaveAccessibleName('Page 1 of 3');
    const pages = within(screen.getByRole('navigation', { name: 'Pages' }));
    expect(pages.getByRole('button', { name: 'Page 2 (flagged values)' })).toBeInTheDocument();
    expect(pages.getByRole('button', { name: 'Page 1' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /table_notes_unrecognised/ }));
    expect(shownPage()).toHaveAccessibleName('Page 2 of 3');
    expect(shownPage()).toHaveAttribute('src', `/api/conversions/items/${ITEM.id}/pages/2`);
  });

  it("puts a note's flags beside the note, and they show its page", async () => {
    const withNote: DecomposedDocument = {
      ...DOCUMENT,
      notes: [
        { id: 'n1', blocks: [{ kind: 'paragraph', id: 'np1', inlines: text('A footnote.') }] },
      ],
      report: [
        {
          code: 'xref_unmatched',
          severity: 'warning',
          at: 'n1',
          message: 'Note reference not found',
        },
        {
          code: 'page_recognised',
          severity: 'warning',
          at: 'np1',
          message: 'Page text recognised',
        },
      ],
    };
    await view(
      reviewApi({
        conversionReview: vi.fn(async () => ({
          ...REVIEW,
          document: withNote as unknown as Record<string, unknown>,
          pageMap: { ...REVIEW.pageMap, np1: [3] },
        })),
      }),
    );
    const note = within(screen.getByText('A footnote.').closest('li')!);
    const pages = within(screen.getByRole('navigation', { name: 'Pages' }));
    expect(pages.getByRole('button', { name: 'Page 3 (flagged values)' })).toBeInTheDocument();

    fireEvent.click(note.getByRole('button', { name: /page_recognised/ }));
    expect(shownPage()).toHaveAccessibleName('Page 3 of 3');
    fireEvent.click(outline().getByRole('button', { name: /^Introduction/ }));
    fireEvent.click(note.getByRole('button', { name: /xref_unmatched/ }));
    expect(shownPage()).toHaveAccessibleName('Page 3 of 3');
  });

  it("shows a heading's first page, or its first block's when it has none", async () => {
    await view();
    fireEvent.click(outline().getByRole('button', { name: /^Results/ }));
    expect(shownPage()).toHaveAccessibleName('Page 3 of 3');
    fireEvent.click(outline().getByRole('button', { name: /^Introduction/ }));
    expect(shownPage()).toHaveAccessibleName('Page 1 of 3');
  });

  it('shows the file name, the target and the flag counts by kind', async () => {
    await view();
    const header = within(screen.getByRole('banner'));
    expect(header.getByText(/Controlled documents/)).toBeInTheDocument();
    const counts = within(header.getByRole('list', { name: 'Flags by kind' }));
    expect(counts.getByText('caption_not_found').closest('li')).toHaveTextContent(
      /caption_not_found\s*2/,
    );
    expect(counts.getByText('table_notes_unrecognised').closest('li')).toHaveTextContent(
      /table_notes_unrecognised\s*1/,
    );
  });

  it('has no editing controls', async () => {
    await view();
    const doc = screen.getByRole('region', { name: 'Decomposed document' });
    expect(within(doc).queryAllByRole('textbox')).toHaveLength(0);
  });

  it('approves and returns to the batch', async () => {
    const api = reviewApi({ approveConversionItem: vi.fn(async () => ({ jobId: 'j1' })) });
    await view(api);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(window.location.hash).toBe(`#/conversion/${BATCH_ID}`));
    expect(api.approveConversionItem).toHaveBeenCalledWith(ITEM.id, undefined);
  });

  it('approves with the note when one is typed', async () => {
    const api = reviewApi({ approveConversionItem: vi.fn(async () => ({ jobId: 'j1' })) });
    await view(api);
    fireEvent.change(screen.getByRole('textbox', { name: /Note/ }), {
      target: { value: ' Checked against the PDF ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(api.approveConversionItem).toHaveBeenCalledWith(ITEM.id, 'Checked against the PDF'),
    );
  });

  it('rejects only with a note, then returns to the batch', async () => {
    const api = reviewApi({
      rejectConversionItem: vi.fn(async () => ({ ...ITEM, outcome: 'rejected' as const })),
    });
    await view(api);
    const reject = screen.getByRole('button', { name: 'Reject' });
    expect(reject).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: /Note/ }), {
      target: { value: '   ' },
    });
    expect(reject).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: /Note/ }), {
      target: { value: 'The table is misread' },
    });
    expect(reject).toBeEnabled();
    fireEvent.click(reject);
    await waitFor(() => expect(window.location.hash).toBe(`#/conversion/${BATCH_ID}`));
    expect(api.rejectConversionItem).toHaveBeenCalledWith(ITEM.id, 'The table is misread');
  });

  it.each([
    ['approve', 'Approve'],
    ['reject', 'Reject'],
  ])('says someone else decided when %s answers 409', async (_, button) => {
    const api = reviewApi({
      approveConversionItem: vi.fn(async () => {
        throw notAwaiting();
      }),
      rejectConversionItem: vi.fn(async () => {
        throw notAwaiting();
      }),
    });
    await view(api);
    fireEvent.change(screen.getByRole('textbox', { name: /Note/ }), {
      target: { value: 'A note' },
    });
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone else has already decided this document',
    );
    expect(screen.getByRole('link', { name: 'Back to the batch' })).toHaveAttribute(
      'href',
      `#/conversion/${BATCH_ID}`,
    );
    expect(window.location.hash).toBe('');
  });

  it('says when the document is no longer awaiting review', async () => {
    const api = reviewApi({
      conversionReview: vi.fn(async () => {
        throw notAwaiting();
      }),
    });
    render(<ConversionReviewPage api={api} itemId={ITEM.id} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This document is no longer awaiting review',
    );
    expect(screen.getByRole('link', { name: /Conversion/ })).toHaveAttribute(
      'href',
      '#/conversion',
    );
  });
});
