import { z } from 'zod';
import { CopySelectionSchema, OcrModeSchema, SectionSchema } from './spec.js';

/**
 * Document type template (outputs-first). Mirrors worker/src/ingest_worker/template.py — both
 * sides validate every template.yaml under /specs in their test suites.
 */
const Id = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase id: [a-z][a-z0-9_-]*');

export const VALUE_TYPES = [
  'text',
  'integer',
  'decimal',
  'date',
  'boolean',
  'enum',
  'list',
] as const;
export const ValueTypeSchema = z.enum(VALUE_TYPES);
export type ValueType = z.infer<typeof ValueTypeSchema>;

/** Reserved output ids (fixed outputs every template writes). */
export const RESERVED_OUTPUT_IDS = new Set(['fields', 'document', 'issues']);

/** A field (atom, one value per document) or a table column. */
export const ValueDefSchema = z
  .object({
    id: Id,
    name: z.string().optional(),
    type: ValueTypeSchema.default('text'),
    description: z.string().optional(),
    enum: z.array(z.string()).min(1).optional(),
  })
  .strict()
  .refine((v) => v.type !== 'enum' || (v.enum?.length ?? 0) > 0, {
    message: 'enum values are required for type enum',
  });
export type ValueDef = z.infer<typeof ValueDefSchema>;

export const TableDefSchema = z
  .object({
    id: Id,
    name: z.string().optional(),
    description: z.string().optional(),
    columns: z.array(ValueDefSchema).min(1),
  })
  .strict();

export const ExtractStepSchema = z
  .object({
    type: z.literal('extract'),
    id: Id,
    fields: z.array(Id).default([]),
    table: Id.optional(),
    sections: z.array(Id).min(1),
    /** Free-text guidance added to the built-in prompt. */
    instructions: z.string().optional(),
    /** Custom Jinja2 prompt file (replaces the built-in prompt). */
    prompt: z.string().optional(),
    model: z.string().default('default'),
    pageImages: z.array(z.number().int().positive()).default([]),
    maxAttempts: z.number().int().min(1).max(5).default(2),
    maxTokens: z.number().int().min(256).max(128000).default(64000),
    chunkPages: z.number().int().positive().optional(),
    /** Values from earlier steps shown in the prompt: name -> `<field>` or `<table>.<column>`. */
    context: z.record(Id, z.string().min(1)).default({}),
  })
  .strict();

/** Paths are `<field>` or `<table>.<column>`. */
export const CheckStepSchema = z
  .object({
    type: z.literal('check'),
    id: Id,
    description: z.string().optional(),
    values: z.string().min(1),
    reference: z.string().min(1),
    aliases: z.string().min(1).optional(),
    maxDistance: z.number().int().min(0).default(2),
  })
  .strict();

export const StepSchema = z.discriminatedUnion('type', [ExtractStepSchema, CheckStepSchema]);

export const TemplateSchema = z
  .object({
    id: Id,
    version: z.number().int().positive(),
    name: z.string().min(1),
    description: z.string().optional(),
    preamble: z.string().optional(),
    document: z
      .object({
        pages: z
          .object({ min: z.number().int().positive(), max: z.number().int().positive() })
          .strict()
          .optional(),
        ocr: OcrModeSchema.default('auto'),
        copies: CopySelectionSchema.optional(),
        pageMarkers: z.boolean().default(true),
        dateOrder: z.enum(['DMY', 'MDY']).default('DMY'),
        sections: z.array(SectionSchema).min(1),
      })
      .strict(),
    outputs: z
      .object({
        fields: z.array(ValueDefSchema).default([]),
        tables: z.array(TableDefSchema).default([]),
      })
      .strict(),
    pipeline: z.array(StepSchema).min(1),
    review: z
      .object({ required: z.enum(['always', 'on_warnings', 'never']).default('on_warnings') })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((t, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const fieldIds = t.outputs.fields.map((f) => f.id);
    const tables = new Map(t.outputs.tables.map((tb) => [tb.id, tb]));
    const sectionIds = new Set(t.document.sections.map((s) => s.id));
    const extracts = t.pipeline.filter((s) => s.type === 'extract');

    const dupes = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    dupes([...fieldIds, ...tables.keys()]).forEach((d) => issue(`duplicate output id "${d}"`));
    dupes(t.pipeline.map((s) => s.id)).forEach((d) => issue(`duplicate step id "${d}"`));
    [...tables.keys(), ...t.pipeline.filter((s) => s.type === 'check').map((s) => s.id)]
      .filter((id) => RESERVED_OUTPUT_IDS.has(id))
      .forEach((id) => issue(`output id "${id}" is reserved`));

    const fills = new Map<string, number>();
    for (const step of extracts) {
      if (step.fields.length > 0 === (step.table !== undefined)) {
        issue(`step "${step.id}": a step must fill either fields or a table`);
      }
      if (step.chunkPages !== undefined && step.table === undefined) {
        issue(`step "${step.id}": only table steps can be chunked`);
      }
      if (step.chunkPages !== undefined && step.sections.length !== 1) {
        issue(`step "${step.id}": chunked steps need exactly one section`);
      }
      step.sections
        .filter((s) => !sectionIds.has(s))
        .forEach((s) => issue(`step "${step.id}": unknown section "${s}"`));
      for (const f of step.fields) {
        if (!fieldIds.includes(f)) issue(`step "${step.id}": unknown field "${f}"`);
        fills.set(f, (fills.get(f) ?? 0) + 1);
      }
      if (step.table !== undefined) {
        if (!tables.has(step.table)) issue(`step "${step.id}": unknown table "${step.table}"`);
        fills.set(step.table, (fills.get(step.table) ?? 0) + 1);
      }
    }
    for (const id of [...fieldIds, ...tables.keys()]) {
      const kind = fieldIds.includes(id) ? 'field' : 'table';
      const count = fills.get(id) ?? 0;
      if (count === 0) issue(`${kind} "${id}" is not filled by any step`);
      if (count > 1) issue(`${kind} "${id}" is filled by more than one step`);
    }

    const resolves = (path: string) => {
      const [head, column] = path.split('.', 2) as [string, string | undefined];
      if (column === undefined) return fieldIds.includes(head);
      return tables.get(head)?.columns.some((c) => c.id === column) ?? false;
    };
    const order = new Map(t.pipeline.map((s, i) => [s.id, i]));
    const fillerOf = (path: string) => {
      const [head, column] = path.split('.', 2) as [string, string | undefined];
      return extracts.find((s) => (column ? s.table === head : s.fields.includes(head)));
    };
    for (const step of extracts) {
      for (const [name, path] of Object.entries(step.context)) {
        if (!resolves(path)) {
          issue(`step "${step.id}": context "${name}": unknown field or column "${path}"`);
          continue;
        }
        const filler = fillerOf(path);
        if (filler && order.get(filler.id)! >= order.get(step.id)!) {
          issue(
            `step "${step.id}": context "${name}" refers to "${path}", which is not filled by an earlier step`,
          );
        }
      }
    }
    for (const step of t.pipeline) {
      if (step.type !== 'check') continue;
      [step.values, step.reference, step.aliases]
        .filter((p): p is string => p !== undefined && !resolves(p))
        .forEach((p) => issue(`check "${step.id}": unknown field or column "${p}"`));
    }
  });

export type Template = z.infer<typeof TemplateSchema>;
