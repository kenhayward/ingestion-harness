import type { ResultDetail } from '@ih/shared';
import { job } from './fake-api.js';

export function resultDetail(overrides: Partial<ResultDetail> = {}): ResultDetail {
  const j = job({
    id: 'j1',
    filename: 'protocol.pdf',
    specId: 'pvp',
    specVersion: 3,
    status: 'succeeded',
    reviewer: 'Ken',
    reviewNote: 'Checked',
    reviewedAt: '2026-10-02T08:00:00Z',
  });
  return {
    job: j,
    target: { bucket: 'ingest-published', prefix: 'pvp/' },
    publishedAt: '2026-10-02T08:00:01.000Z',
    outputs: [
      {
        outputId: 'document',
        stage: 'published',
        format: 'json',
        bucket: 'ingest-published',
        key: 'pvp/x/document/d.json',
        rowCount: null,
      },
      {
        outputId: 'results',
        stage: 'published',
        format: 'csv',
        bucket: 'ingest-published',
        key: 'pvp/x/results/d.csv',
        rowCount: 2,
      },
    ],
    document: {
      document_id: 'd',
      fields: {
        product: { value: 'Aspirin' },
        batches: { value: ['B1', 'B2'] },
        approved: { value: true },
        extra: { value: { lot: 7 } },
        missing: { value: null },
        lots: { value: [{ lot: 1 }, { lot: 2 }] },
      },
      tables: {
        results: [
          { batch: 'B1', value: 1.5 },
          { batch: 'B2', value: 2 },
        ],
      },
      checks: { batch_check: { rows: [{ value: 'B1', status: 'ok' }] } },
      issues: [
        {
          step: 'data',
          target: 'results',
          row: 2,
          column: 'value',
          raw: '2,0O',
          message: 'unreadable',
        },
      ],
      review: {
        reviewer: 'Ken',
        note: 'Checked',
        reviewed_at: '2026-10-02T08:00:00Z',
        edits: [
          { field: 'product', value: 'Aspirin' },
          { table: 'results', row: 2, column: 'value', value: 2 },
        ],
      },
      published_at: '2026-10-02T08:00:01Z',
    },
    documentError: null,
    definition: {
      kind: 'template',
      fields: [
        { id: 'product', name: 'Product', type: 'text' },
        { id: 'batches', type: 'list' },
        { id: 'approved', type: 'boolean' },
        { id: 'extra', type: 'text' },
        { id: 'missing', name: 'Missing value', type: 'text' },
        { id: 'lots', type: 'list' },
      ],
      tables: [
        {
          id: 'results',
          name: 'Test results',
          columns: [
            { id: 'batch', name: 'Batch', type: 'text' },
            { id: 'value', type: 'decimal' },
          ],
        },
      ],
    },
    ...overrides,
  };
}
