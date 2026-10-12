import { z } from 'zod';

/**
 * Document spec format. The Python worker mirrors this in
 * worker/src/ingest_worker/specs.py — both sides validate every file under /specs
 * in their test suites, so a change here must be made there too.
 */
const Id = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase id: [a-z][a-z0-9_-]*');

export const SectionSchema = z
  .object({
    id: Id,
    /** Regex (multiline) whose first match marks the start of the section. */
    anchor: z.string().min(1),
    required: z.boolean().default(true),
    description: z.string().optional(),
  })
  .strict();

export const ExtractionSchema = z
  .object({
    id: Id,
    /** Section ids whose text is passed to the prompt. */
    sections: z.array(Id).min(1),
    /** Jinja2 template path, relative to the spec's version directory. */
    prompt: z.string().min(1),
    /** Model alias (e.g. "default") or "provider/model-id". */
    model: z.string().default('default'),
    /** JSON Schema the LLM output must satisfy. */
    schema: z.record(z.unknown()),
    maxAttempts: z.number().int().min(1).max(5).default(2),
    /** 1-based PDF pages sent as images with the prompt (needs a vision-capable model). */
    pageImages: z.array(z.number().int().positive()).default([]),
    /** Output token budget per LLM call. */
    maxTokens: z.number().int().min(256).max(128000).default(64000),
    /** Run once per N pages of the (single) section and concatenate `mergePath` arrays. */
    chunkPages: z.number().int().positive().optional(),
    /** Top-level array property of the schema merged across chunks. */
    mergePath: z.string().min(1).optional(),
    /** Extra prompt variables (set when compiled from a document template). */
    promptContext: z.record(z.unknown()).optional(),
  })
  .strict();

export const CsvColumnSchema = z
  .object({
    name: z.string().min(1),
    /** Dotted path into each row object, e.g. "supplier.name". */
    path: z.string().min(1),
  })
  .strict();

export const OutputSchema = z.discriminatedUnion('format', [
  z
    .object({
      id: Id,
      format: z.literal('csv'),
      from: Id,
      /** Dotted path to an array within the extraction result; empty = the result is one row. */
      rowsPath: z.string().default(''),
      columns: z.array(CsvColumnSchema).min(1),
    })
    .strict(),
  z
    .object({
      id: Id,
      format: z.literal('json'),
      /** Extraction id, or "*" for all extractions merged by id. */
      from: z.union([Id, z.literal('*')]),
    })
    .strict(),
]);

/**
 * For PDFs holding several copies of the document (e.g. the approved blank protocol followed by
 * the executed one): pages are split where `anchor` matches and one copy is kept.
 */
export const CopySelectionSchema = z
  .object({
    anchor: z.string().min(1),
    select: z.enum(['first', 'last']).default('last'),
  })
  .strict();

/** Deterministic cross-extraction consistency check (worker/src/ingest_worker/checks.py). */
export const CheckSchema = z
  .object({
    id: Id,
    description: z.string().optional(),
    /** Values to classify, e.g. "test_results.results[*].batch_number". */
    values: z.string().min(1),
    /** Reference values, e.g. "batches.batches[*].batch_number". */
    reference: z.string().min(1),
    /** Per-reference alternative spellings, sharing the reference's list prefix. */
    aliases: z.string().min(1).optional(),
    /** Max edit distance for a "near" match. */
    maxDistance: z.number().int().min(0).default(2),
  })
  .strict();

const pathRoot = (path: string) => path.split('.')[0]!.split('[')[0]!;

export const OcrModeSchema = z.enum(['auto', 'always', 'never']);
export type OcrMode = z.infer<typeof OcrModeSchema>;

export const DocumentSpecSchema = z
  .object({
    id: Id,
    version: z.number().int().positive(),
    title: z.string().min(1),
    description: z.string().optional(),
    document: z
      .object({
        pages: z
          .object({ min: z.number().int().positive(), max: z.number().int().positive() })
          .strict()
          .optional(),
        /** auto: OCR pages with little/no text layer; always: OCR every page; never: text layer only. */
        ocr: OcrModeSchema.default('auto'),
        copies: CopySelectionSchema.optional(),
        sections: z.array(SectionSchema).min(1),
      })
      .strict(),
    extractions: z.array(ExtractionSchema).min(1),
    outputs: z.array(OutputSchema).min(1),
    checks: z.array(CheckSchema).default([]),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const sectionIds = new Set(spec.document.sections.map((s) => s.id));
    const extractionIds = new Set(spec.extractions.map((e) => e.id));

    const dupes = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);
    for (const [label, ids] of [
      ['section', spec.document.sections.map((s) => s.id)],
      ['extraction', spec.extractions.map((e) => e.id)],
      ['output', spec.outputs.map((o) => o.id)],
      ['extraction/check', [...spec.extractions, ...spec.checks].map((x) => x.id)],
    ] as const) {
      for (const d of dupes([...ids])) {
        ctx.addIssue({ code: 'custom', message: `duplicate ${label} id "${d}"` });
      }
    }

    spec.extractions.forEach((e, i) =>
      e.sections.forEach((s) => {
        if (!sectionIds.has(s)) {
          ctx.addIssue({
            code: 'custom',
            path: ['extractions', i, 'sections'],
            message: `unknown section "${s}"`,
          });
        }
      }),
    );

    spec.extractions.forEach((e, i) => {
      if (e.chunkPages === undefined) return;
      const path = ['extractions', i];
      if (e.sections.length !== 1) {
        ctx.addIssue({ code: 'custom', path, message: 'chunkPages needs exactly one section' });
      }
      if (!e.mergePath) {
        ctx.addIssue({ code: 'custom', path, message: 'chunkPages needs mergePath' });
        return;
      }
      const props = (e.schema as { properties?: Record<string, { type?: unknown }> }).properties;
      if (props?.[e.mergePath]?.type !== 'array') {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `mergePath "${e.mergePath}" must be a top-level array property of the schema`,
        });
      }
    });

    spec.checks.forEach((c, i) => {
      for (const [label, path] of [
        ['values', c.values],
        ['reference', c.reference],
        ['aliases', c.aliases],
      ] as const) {
        if (path !== undefined && !extractionIds.has(pathRoot(path))) {
          ctx.addIssue({
            code: 'custom',
            path: ['checks', i, label],
            message: `unknown extraction "${pathRoot(path)}"`,
          });
        }
      }
      if (c.aliases) {
        const cut = c.reference.lastIndexOf('[*]');
        const prefix = cut >= 0 ? c.reference.slice(0, cut + 3) : pathRoot(c.reference);
        if (!c.aliases.startsWith(`${prefix}.`)) {
          ctx.addIssue({
            code: 'custom',
            path: ['checks', i, 'aliases'],
            message: `aliases must start with "${prefix}"`,
          });
        }
      }
    });

    const sources = new Set([...extractionIds, ...spec.checks.map((c) => c.id)]);
    spec.outputs.forEach((o, i) => {
      if (o.from !== '*' && !sources.has(o.from)) {
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', i, 'from'],
          message: `unknown extraction "${o.from}"`,
        });
      }
    });

    if (spec.document.pages && spec.document.pages.min > spec.document.pages.max) {
      ctx.addIssue({ code: 'custom', path: ['document', 'pages'], message: 'min > max' });
    }
  });

export type DocumentSpec = z.infer<typeof DocumentSpecSchema>;

export interface SpecSummary {
  id: string;
  version: number;
  title: string;
  description?: string;
}
