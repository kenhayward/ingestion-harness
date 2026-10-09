import type { ReviewData } from '../src/api/client.js';
import { job } from './fake-api.js';

export const JOB_ID = '11111111-1111-4111-8111-111111111111';

export function reviewData(overrides: Partial<ReviewData> = {}): ReviewData {
  return {
    job: {
      ...job({ id: JOB_ID, filename: 'scan.pdf', specId: 'tdemo', status: 'awaiting_review' }),
      reviewReasons: ['1 normalisation issue(s)', 'check batch_check: 1 unmatched'],
      outputs: [],
    },
    template: {
      id: 'tdemo',
      version: 1,
      name: 'Template demo',
      document: {
        ocr: 'auto',
        pageMarkers: true,
        dateOrder: 'DMY',
        sections: [{ id: 'all', anchor: '\\A', required: true }],
      },
      outputs: {
        fields: [
          { id: 'product', name: 'Medicinal Product', type: 'text' },
          { id: 'executed_on', name: 'Execution Date', type: 'date' },
          { id: 'kind', type: 'enum', enum: ['protocol', 'report'] },
          { id: 'compound', type: 'list' },
        ],
        tables: [
          {
            id: 'results',
            columns: [
              { id: 'batch', type: 'text' },
              { id: 'value', type: 'decimal' },
            ],
          },
        ],
      },
      pipeline: [
        {
          type: 'extract',
          id: 'head',
          fields: ['product', 'executed_on', 'kind', 'compound'],
          sections: ['all'],
          model: 'default',
          pageImages: [],
          maxAttempts: 2,
          maxTokens: 16000,
        },
        {
          type: 'extract',
          id: 'data',
          fields: [],
          table: 'results',
          sections: ['all'],
          model: 'default',
          pageImages: [],
          maxAttempts: 2,
          maxTokens: 16000,
        },
        {
          type: 'check',
          id: 'batch_check',
          values: 'results.batch',
          reference: 'results.batch',
          maxDistance: 2,
        },
      ],
      review: { required: 'on_warnings' },
    },
    document: {
      document_id: 'doc-1',
      page_count: 3,
      fields: {
        product: { value: 'Richfer capsules', evidence: 'Product: Richfer capsules', page: 1 },
        executed_on: { value: '2023-02-16', evidence: 'Made 16/02/2023', page: 3 },
        kind: { value: 'protocol', evidence: null, page: null },
        compound: { value: ['Carbonyl Iron', 'Folic Acid'], evidence: 'Carbonyl Iron', page: 2 },
      },
      tables: {
        results: [
          { batch: 'G1', value: 137.8 },
          { batch: 'GX', value: 'Complies' },
          { batch: 'G1', value: 120.1 },
        ],
      },
      checks: {
        batch_check: {
          rows: [
            { value: 'G1', status: 'match', matched: 'G1', distance: 0, count: 2 },
            { value: 'GX', status: 'unmatched', matched: null, distance: null, count: 1 },
          ],
        },
      },
      issues: [
        {
          step: 'data',
          target: 'results',
          row: 2,
          column: 'value',
          raw: 'Complies',
          message: "'Complies' is not a valid decimal",
        },
      ],
    },
    edits: [],
    ...overrides,
  };
}
