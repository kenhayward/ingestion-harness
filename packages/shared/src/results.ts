import { z } from 'zod';
import { JobOutputSchema, JobSummarySchema, OUTPUT_FORMATS } from './jobs.js';
import { TableDefSchema, ValueDefSchema } from './template.js';

/** A published file of a result (GET /api/results rows link their downloads with it). */
export const ResultOutputSchema = z.object({
  outputId: z.string(),
  format: z.enum(OUTPUT_FORMATS),
  /** The object key's base name, e.g. `line_items.csv`. */
  name: z.string(),
  rowCount: z.number().int().nullable(),
});
export type ResultOutput = z.infer<typeof ResultOutputSchema>;

/** GET /api/results `show`: approved by a person, published without review, or with issues. */
export const RESULT_SHOWS = ['reviewed', 'auto', 'issues'] as const;
export type ResultShow = (typeof RESULT_SHOWS)[number];

/** One published (non-test) job in GET /api/results, newest publish first. */
export const ResultSummarySchema = z.object({
  jobId: z.string(),
  documentId: z.string(),
  filename: z.string(),
  /** The uploaded file's type: `application/pdf`, or the .docx type for a Word document. */
  contentType: z.string(),
  specId: z.string(),
  specVersion: z.number().int(),
  publishedAt: z.string(),
  /** Null when published without review, or approved without a name (see reviewedAt). */
  reviewer: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  outputCount: z.number().int(),
  /** Published outputs, by outputId. */
  outputs: z.array(ResultOutputSchema),
  /** row_count of the published `issues` output; null when there is none (legacy specs). */
  issueCount: z.number().int().nullable(),
});
export type ResultSummary = z.infer<typeof ResultSummarySchema>;

const Row = z.record(z.string(), z.unknown());

export const PublishedEditSchema = z
  .object({
    field: z.string().nullable().optional(),
    table: z.string().nullable().optional(),
    row: z.number().int().nullable().optional(),
    column: z.string().nullable().optional(),
    value: z.unknown().optional(),
  })
  .passthrough();

/** document.json as published by the worker (template jobs). Unknown keys pass through. */
export const PublishedDocumentSchema = z
  .object({
    document_id: z.string(),
    fields: z
      .record(z.string(), z.object({ value: z.unknown().optional() }).passthrough())
      .default({}),
    tables: z.record(z.string(), z.array(Row)).default({}),
    checks: z.record(z.string(), z.object({ rows: z.array(Row) }).passthrough()).default({}),
    issues: z.array(Row).default([]),
    review: z
      .object({
        reviewer: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
        reviewed_at: z.string().nullable().optional(),
        edits: z.array(PublishedEditSchema).default([]),
      })
      .passthrough()
      .optional(),
    published_at: z.string().optional(),
  })
  .passthrough();
export type PublishedDocument = z.infer<typeof PublishedDocumentSchema>;

export const ResultDefinitionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('template'),
    fields: z.array(ValueDefSchema),
    tables: z.array(TableDefSchema),
  }),
  z.object({ kind: z.literal('spec') }),
  /** The job's document type/version could not be resolved. */
  z.object({ kind: z.literal('unknown') }),
]);
export type ResultDefinition = z.infer<typeof ResultDefinitionSchema>;

export const DocumentErrorSchema = z.enum([
  'missing from target',
  'target storage unavailable',
  'invalid document',
]);
export type DocumentError = z.infer<typeof DocumentErrorSchema>;

export const ResultDetailSchema = z.object({
  job: JobSummarySchema,
  /** The publishing target the outputs were delivered to, with the bucket they were written to. */
  target: z.object({ id: z.string(), label: z.string(), bucket: z.string(), prefix: z.string() }),
  /** Latest published job_outputs.created_at (same value as the list's publishedAt). */
  publishedAt: z.string(),
  /** Published outputs only. */
  outputs: z.array(JobOutputSchema),
  document: PublishedDocumentSchema.nullable(),
  documentError: DocumentErrorSchema.nullable(),
  definition: ResultDefinitionSchema,
});
export type ResultDetail = z.infer<typeof ResultDetailSchema>;
