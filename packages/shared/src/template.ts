import { z } from 'zod';
import { CopySelectionSchema, ID_PATTERN, OcrModeSchema, SectionSchema } from './spec.js';

/**
 * Document type template (outputs-first). Mirrors worker/src/ingest_worker/template.py — both
 * sides validate every template.yaml under /specs in their test suites.
 */
const Id = z.string().regex(ID_PATTERN, 'lowercase id: [a-z][a-z0-9_-]*');

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
    /** A model choice; `default` (the default) inherits the template's `model`. */
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

/** Which extract steps fill one output (handoff TP2). */
export interface OutputFill {
  id: string;
  kind: 'field' | 'table';
  /** Ids of the extract steps that fill it, in pipeline order (listed twice: appears twice). */
  steps: string[];
}

export interface OutputCoverage {
  /** Fields in order, then each distinct table id. */
  outputs: OutputFill[];
  /** Outputs no step fills. */
  uncovered: string[];
  /** Outputs more than one step fills. */
  multiple: string[];
}

type Loose = Record<string, unknown>;
const looseObj = (v: unknown): Loose =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : {};
const looseList = (v: unknown): Loose[] => (Array.isArray(v) ? v.map(looseObj) : []);
const looseIds = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Which extract step fills each output. Reads any definition, parsed or a raw draft (the Steps
 * tab's coverage strip), skipping malformed parts. The template validation's "is not filled by
 * any step" / "is filled by more than one step" issues come from this.
 */
export function outputCoverage(definition: unknown): OutputCoverage {
  const def = looseObj(definition);
  const outputs = looseObj(def.outputs);
  const fieldIds = looseIds(looseList(outputs.fields).map((f) => f.id));
  const tableIds = [...new Set(looseIds(looseList(outputs.tables).map((t) => t.id)))];
  const extracts = looseList(def.pipeline).filter(
    (s): s is Loose & { id: string } => s.type === 'extract' && typeof s.id === 'string',
  );
  const rows: OutputFill[] = [...fieldIds, ...tableIds].map((id) => ({
    id,
    kind: fieldIds.includes(id) ? 'field' : 'table',
    steps: extracts.flatMap((s) => [
      ...looseIds(s.fields)
        .filter((f) => f === id)
        .map(() => s.id),
      ...(s.table === id ? [s.id] : []),
    ]),
  }));
  return {
    outputs: rows,
    uncovered: rows.filter((r) => r.steps.length === 0).map((r) => r.id),
    multiple: rows.filter((r) => r.steps.length > 1).map((r) => r.id),
  };
}

export const TemplateSchema = z
  .object({
    id: Id,
    version: z.number().int().positive(),
    name: z.string().min(1),
    description: z.string().optional(),
    preamble: z.string().optional(),
    /**
     * The document type's model choice, inherited by every extract step that names none
     * (absent: the default model choice).
     */
    model: z.string().min(1).optional(),
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
      }
      if (step.table !== undefined && !tables.has(step.table)) {
        issue(`step "${step.id}": unknown table "${step.table}"`);
      }
    }
    for (const o of outputCoverage(t).outputs) {
      if (o.steps.length === 0) issue(`${o.kind} "${o.id}" is not filled by any step`);
      if (o.steps.length > 1) issue(`${o.kind} "${o.id}" is filled by more than one step`);
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

/**
 * The model an extract step runs (before any job override): its own, else the template's,
 * else the default choice. Held in step with `Template.step_model` in the worker.
 */
export function stepModel(
  template: Pick<Template, 'model'>,
  step: Pick<z.infer<typeof ExtractStepSchema>, 'model'>,
): string {
  return step.model !== 'default' ? step.model : (template.model ?? 'default');
}
