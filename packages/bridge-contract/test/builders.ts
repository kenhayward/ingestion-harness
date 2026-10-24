import { readFileSync } from 'node:fs';
import type { BridgePackage } from '../src/index.js';

/** A package file named `name`, carrying a tiny CSV. */
export const file = (name: string) => ({
  output: 'fields',
  format: 'csv',
  contentType: 'text/csv; charset=utf-8',
  name,
  content: Buffer.from('document_id,total\ndoc1,12\n').toString('base64'),
});

/** A valid document package with one CSV file. */
export const docPackage: BridgePackage = {
  kind: 'document',
  contractVersion: 1,
  producer: { name: 'ct-studio', deployment: 'test' },
  idempotencyKey: 'b'.repeat(64),
  provenance: {
    sourceSha256: 'a'.repeat(64),
    sourceFilename: 'invoice.pdf',
    jobId: 'job-1',
    recipeId: 'invoice',
    recipeVersion: 3,
    approver: { id: 'u1', name: 'Pat Reviewer', email: 'pat@example.com' },
    extractedAt: '2026-10-19T10:00:00.000Z',
    publishedAt: '2026-10-19T11:00:00.000Z',
  },
  naming: {},
  files: [file('invoice/v3/fields/doc1.csv')],
  data: {
    fields: [{ id: 'total', title: 'Total', type: 'number', value: 12, unit: 'GBP' }],
    tables: [],
  },
  rdf: null,
  narrative: null,
  images: null,
};

/** A valid version 2 package: the decomposed fixture (a document and the images it references). */
export const decomposedPackage = JSON.parse(
  readFileSync(new URL('./fixtures/package-decomposed.json', import.meta.url), 'utf8'),
) as BridgePackage;
