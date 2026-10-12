import { describe, expect, it } from 'vitest';
import { PublishedDocumentSchema, ResultDetailSchema, ResultSummarySchema } from '../src/index.js';

// Shape written by worker template_pipeline.render_document + publish_template_job.
const publishedDocument = {
  document_id: 'd1',
  job_id: 'j1',
  template: { id: 'tdemo', version: 1, name: 'Template demo' },
  extracted_at: '2026-10-11T10:00:00+00:00',
  page_count: 3,
  models: ['local/qwen'],
  fields: { product: { value: 'Aspirin', raw: 'ASPIRIN', page: 1 }, executed_on: { value: null } },
  tables: { results: [{ batch: 'B1', value: 1.5 }] },
  checks: {
    batch_check: { rows: [{ value: 'B1', status: 'ok', matched: 'B1', distance: 0, count: 1 }] },
  },
  issues: [{ step: 'data', target: 'results', row: 1, column: 'value', raw: 'x', message: 'bad' }],
  review_required: true,
  review_reasons: ['issues'],
  review: {
    decision: 'approved',
    reviewer: 'Ken',
    note: null,
    reviewed_at: '2026-10-11T11:00:00+00:00',
    edits: [
      {
        field: 'product',
        table: null,
        row: null,
        column: null,
        value: 'Aspirin',
        editor: 'Ken',
        reason: null,
        at: '2026-10-11T10:59:00+00:00',
      },
    ],
  },
  published_at: '2026-10-11T11:00:01+00:00',
};

describe('result schemas', () => {
  it('parses a published template document and keeps unknown keys', () => {
    const doc = PublishedDocumentSchema.parse(publishedDocument);
    expect(doc.fields.product?.value).toBe('Aspirin');
    expect(doc.review?.edits[0]?.field).toBe('product');
    expect((doc as Record<string, unknown>).page_count).toBe(3);
  });

  it('defaults missing collections', () => {
    const doc = PublishedDocumentSchema.parse({ document_id: 'd1' });
    expect(doc).toMatchObject({ fields: {}, tables: {}, checks: {}, issues: [] });
  });

  it('validates summaries and details', () => {
    expect(
      ResultSummarySchema.parse({
        jobId: 'j1',
        documentId: 'd1',
        filename: 'a.pdf',
        specId: 'tdemo',
        specVersion: 1,
        publishedAt: '2026-10-11T11:00:01.000Z',
        reviewer: null,
        reviewedAt: null,
        outputCount: 4,
        outputs: [],
        issueCount: null,
      }).outputCount,
    ).toBe(4);
    expect(() =>
      ResultDetailSchema.parse({
        job: {},
        target: { bucket: 'b', prefix: '' },
        outputs: [],
        document: null,
        documentError: 'nope',
        definition: { kind: 'spec' },
      }),
    ).toThrow();
  });
});
