import { z } from 'zod';
import { PublishToSchema, type PublishTo } from './publish-targets.js';
import { pythonPatternCompiles } from './python-pattern.js';
import {
  CopySelectionSchema,
  ID_PATTERN,
  keyFromIssues,
  OcrModeSchema,
  SectionSchema,
} from './spec.js';

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
export const RESERVED_OUTPUT_IDS = new Set(['fields', 'document', 'issues', 'graph']);

/** A field (atom, one value per document) or a table column. */
/** A constraint's bounds (docs/design/output-roles.md §1): either may be left out. */
const BoundSchema = z.object({ min: z.number().optional(), max: z.number().optional() }).strict();

/**
 * Whether a constraint pattern (Python `re` syntax, as section anchors) is one the worker
 * accepts (`pythonPatternCompiles`).
 */
export function patternCompiles(pattern: string): boolean {
  return pythonPatternCompiles(pattern);
}

export const ValueDefSchema = z
  .object({
    id: Id,
    name: z.string().optional(),
    type: ValueTypeSchema.default('text'),
    description: z.string().optional(),
    enum: z.array(z.string()).min(1).optional(),
    /** Numbers outside it are review issues (decimal and integer). */
    range: BoundSchema.optional(),
    /** The whole value must match it (text; Python `re` syntax). */
    pattern: z.string().min(1).optional(),
    /** Its length in characters (text). */
    length: BoundSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (v.type === 'enum' && (v.enum?.length ?? 0) === 0) {
      issue('enum values are required for type enum');
    }
    const bounds = (name: string, b: z.infer<typeof BoundSchema>) => {
      if (b.min === undefined && b.max === undefined) issue(`"${v.id}": ${name} needs min or max`);
      if (b.min !== undefined && b.max !== undefined && b.min > b.max) {
        issue(`"${v.id}": ${name} min is above max`);
      }
    };
    if (v.range) {
      if (v.type !== 'decimal' && v.type !== 'integer') {
        issue(`"${v.id}": range needs a decimal or integer`);
      }
      bounds('range', v.range);
    }
    if (v.pattern !== undefined) {
      if (v.type !== 'text') issue(`"${v.id}": pattern needs a text`);
      if (!patternCompiles(v.pattern)) issue(`"${v.id}": "${v.pattern}" is not a valid pattern`);
    }
    if (v.length) {
      if (v.type !== 'text') issue(`"${v.id}": length needs a text`);
      if ((v.length.min ?? 0) < 0 || (v.length.max ?? 0) < 0) {
        issue(`"${v.id}": length cannot be negative`);
      }
      if (![v.length.min ?? 0, v.length.max ?? 0].every(Number.isInteger)) {
        issue(`"${v.id}": length must be whole numbers`);
      }
      bounds('length', v.length);
    }
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

/**
 * Which occurrences of its repeating section a step reads: `match` is a regex (Python `re`
 * syntax) the worker searches, ignoring case, in each occurrence's first 600 characters with
 * line breaks and repeated spaces read as one (`segment.occurrence_matches`); the others are
 * skipped without a model call.
 */
export const OccurrenceFilterSchema = z.object({ match: z.string().min(1) }).strict();
export type OccurrenceFilter = z.infer<typeof OccurrenceFilterSchema>;

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
    /** The table column the worker fills with each occurrence's key (repeating sections). */
    keyColumn: Id.optional(),
    /** Only the occurrences of its repeating section whose heading matches (absent: all). */
    occurrences: OccurrenceFilterSchema.optional(),
    /**
     * A table step that enriches an earlier step's rows (P4): the columns it fills, the rest
     * being the creating step's. Absent: the step creates the table's rows.
     */
    columns: z.array(Id).min(1).optional(),
  })
  .strict();

/** A plugin's id and the major version a recipe runs: `text.pattern@1` (worker `PLUGIN_REF`). */
export const PLUGIN_REF = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+@[1-9][0-9]*$/;

/**
 * Paths are `<field>` or `<table>.<column>`. A check compares `values` with a `reference`, or
 * runs a check plugin (`uses`, with its own settings in `with`); exactly one of the two.
 */
export const CheckStepSchema = z
  .object({
    type: z.literal('check'),
    id: Id,
    description: z.string().optional(),
    values: z.string().min(1),
    reference: z.string().min(1).optional(),
    aliases: z.string().min(1).optional(),
    maxDistance: z.number().int().min(0).default(2),
    /** A check plugin and its major version (instead of a reference). */
    uses: z
      .string()
      .regex(PLUGIN_REF, 'name a plugin and its major version, e.g. list.lookup@1')
      .optional(),
    /** The check plugin's own settings. */
    with: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.uses !== undefined && c.reference !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'a check runs a plugin or compares with a reference, not both',
      });
    } else if (c.uses === undefined && c.reference === undefined) {
      ctx.addIssue({ code: 'custom', message: 'a check needs a reference or a plugin' });
    }
  });

/**
 * A step that runs a registered worker plugin instead of a model call (docs/design/recipe-plugins.md).
 * It fills fields or one table like an extract step; `with` is the plugin's own settings, checked
 * against its schema by the worker (and, once the plugin catalogue exists, by the API).
 */
export const PluginStepSchema = z
  .object({
    type: z.literal('plugin'),
    id: Id,
    uses: z.string().regex(PLUGIN_REF, 'name a plugin and its major version, e.g. text.pattern@1'),
    fields: z.array(Id).default([]),
    table: Id.optional(),
    /** The text it reads (none: it reads only earlier values). */
    sections: z.array(Id).default([]),
    /** Earlier values it may read: name -> `<field>` or `<table>.<column>`. */
    context: z.record(Id, z.string().min(1)).default({}),
    /** The plugin's own settings. */
    with: z.record(z.string(), z.unknown()).default({}),
    /**
     * A model choice, for a plugin that calls a model (egress `model`); absent (no default, so
     * older recipes parse and hash as before), the document type's model.
     */
    model: z.string().min(1).optional(),
    /** The table column the worker fills with each occurrence's key (repeating sections). */
    keyColumn: Id.optional(),
    /** Only the occurrences of its repeating section whose heading matches (absent: all). */
    occurrences: OccurrenceFilterSchema.optional(),
    /**
     * A table step that enriches an earlier step's rows (P4): the columns it fills, the rest
     * being the creating step's. Absent: the step creates the table's rows.
     */
    columns: z.array(Id).min(1).optional(),
  })
  .strict();

export const StepSchema = z.discriminatedUnion('type', [
  ExtractStepSchema,
  CheckStepSchema,
  PluginStepSchema,
]);

/** The step types that fill outputs (extract and plugin steps). */
export const FILLING_STEP_TYPES: ReadonlySet<string> = new Set(['extract', 'plugin']);

/** Which steps fill one output (handoff TP2): extract and plugin steps. */
export interface OutputFill {
  id: string;
  kind: 'field' | 'table';
  /**
   * Ids of the steps that fill it, in pipeline order (listed twice: appears twice); for a table,
   * the steps creating its rows (not those enriching it).
   */
  steps: string[];
  /**
   * A table some step enriches (P4): the step filling each column (its enriching step, else the
   * creating steps). Absent: the creating step fills every column.
   */
  columns?: { id: string; steps: string[] }[];
}

export interface OutputCoverage {
  /** Fields in order, then each distinct table id. */
  outputs: OutputFill[];
  /** Outputs no step fills. */
  uncovered: string[];
  /** Outputs more than one step fills, and `table.column`s two enriching steps fill. */
  multiple: string[];
}

type Loose = Record<string, unknown>;
const looseObj = (v: unknown): Loose =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : {};
const looseList = (v: unknown): Loose[] => (Array.isArray(v) ? v.map(looseObj) : []);
const looseIds = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Which step (extract or plugin) fills each output. Reads any definition, parsed or a raw draft (the Pipeline
 * tab's coverage strip), skipping malformed parts. The template validation's "is not filled by
 * any step" / "is filled by more than one step" issues come from this.
 */
export function outputCoverage(definition: unknown): OutputCoverage {
  const def = looseObj(definition);
  const outputs = looseObj(def.outputs);
  const fieldIds = looseIds(looseList(outputs.fields).map((f) => f.id));
  const tables = looseList(outputs.tables);
  const tableIds = [...new Set(looseIds(tables.map((t) => t.id)))];
  const fillers = looseList(def.pipeline).filter(
    (s): s is Loose & { id: string } =>
      FILLING_STEP_TYPES.has(String(s.type)) && typeof s.id === 'string',
  );
  const enriches = (s: Loose) => looseIds(s.columns).length > 0;
  const rows: OutputFill[] = [...fieldIds, ...tableIds].map((id) => {
    if (fieldIds.includes(id)) {
      const steps = fillers.flatMap((s) =>
        looseIds(s.fields)
          .filter((f) => f === id)
          .map(() => s.id),
      );
      return { id, kind: 'field', steps };
    }
    const creators = fillers.filter((s) => s.table === id && !enriches(s)).map((s) => s.id);
    const enrichers = fillers.filter((s) => s.table === id && enriches(s));
    if (enrichers.length === 0) return { id, kind: 'table', steps: creators };
    const columnIds = looseIds(
      looseList(tables.find((t) => t.id === id)?.columns).map((c) => c.id),
    );
    const columns = columnIds.map((c) => {
      const own = enrichers.filter((s) => looseIds(s.columns).includes(c)).map((s) => s.id);
      return { id: c, steps: own.length > 0 ? own : creators };
    });
    return { id, kind: 'table', steps: creators, columns };
  });
  return {
    outputs: rows,
    uncovered: rows.filter((r) => r.steps.length === 0).map((r) => r.id),
    multiple: [
      ...rows.filter((r) => r.steps.length > 1).map((r) => r.id),
      ...rows.flatMap((r) =>
        (r.columns ?? [])
          .filter((c) => c.steps.length > 1 && !r.steps.includes(c.steps[0]!))
          .map((c) => `${r.id}.${c.id}`),
      ),
    ],
  };
}

/** The steps creating and enriching one table of a parsed recipe (P4). */
function tableSteps<S extends { id: string; table?: string; columns?: string[] }>(
  fillers: readonly S[],
  table: string,
): { creators: S[]; enrichers: S[] } {
  const on = fillers.filter((s) => s.table === table);
  return {
    creators: on.filter((s) => s.columns === undefined),
    enrichers: on.filter((s) => s.columns !== undefined),
  };
}

/** A term: a CURIE (`acme:Batch`, with `semantics.prefixes` or a built-in prefix) or an IRI. */
const TermRef = z.string().min(1);

/** Prefixes every mapping may use without declaring them. */
export const CURIE_PREFIXES: Record<string, string> = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  dcterms: 'http://purl.org/dc/terms/',
  prov: 'http://www.w3.org/ns/prov#',
};

export const OntologyPinSchema = z
  .object({ id: z.string().min(1), version: z.number().int().positive() })
  .strict();

/**
 * A value node's own terms: the value sits on a node of `class`, minted per row (per document for
 * a field). Terms left out come from `semantics.valueNodes`.
 */
export const NodeMappingSchema = z
  .object({
    /** The node's class: what the value is (e.g. a water mass fraction). */
    class: TermRef,
    /** The property from the node to the value (absent: `valueNodes.value`). */
    value: TermRef.optional(),
    /** A fixed unit IRI (e.g. `unit:PERCENT`); absent: no unit. */
    unit: TermRef.optional(),
    /** The property from the node to its unit (absent: `valueNodes.unitProperty`). */
    unitProperty: TermRef.optional(),
  })
  .strict();
export type NodeMapping = z.infer<typeof NodeMappingSchema>;

/** What every value node uses unless its output gives its own. */
export const ValueNodeDefaultsSchema = z
  .object({
    /** The property from the document or row to a value node. */
    link: TermRef.optional(),
    /** The property from a value node to its value. */
    value: TermRef.optional(),
    /** The property from a value node to its unit. */
    unitProperty: TermRef.optional(),
  })
  .strict();
export type ValueNodeDefaults = z.infer<typeof ValueNodeDefaultsSchema>;

/**
 * How one field or column becomes RDF: a literal, an entity, a link to a SKOS concept, or a value
 * node of a class.
 */
export const OutputMappingSchema = z
  .object({
    /** The property from the document or row; for a value node its link (absent: `valueNodes.link`). */
    property: TermRef.optional(),
    /** The value names an entity: its class and readable IRI template (e.g. `party/{value|slug}`). */
    object: z
      .object({ class: TermRef, iri: z.string().min(1), label: z.boolean().optional() })
      .strict()
      .optional(),
    /** The value links to a concept: by explicit value, or by label within `scheme`. */
    concepts: z
      .object({
        scheme: TermRef.optional(),
        values: z.record(z.string(), TermRef).optional(),
        match: z.literal('label').optional(),
      })
      .strict()
      .optional(),
    /** The value sits on a node of a class (class-centric ontologies such as AFO and OBI). */
    node: NodeMappingSchema.optional(),
  })
  .strict();
export type OutputMapping = z.infer<typeof OutputMappingSchema>;

/** A table's mapping: the link from the document to each row, the row class, its columns. */
export const TableMappingSchema = z
  .object({
    /** The property from the document to each row. */
    link: TermRef,
    class: TermRef,
    /** Readable row IRI from its columns (absent: `doc/{sha256}/{type}/{table}/{n}`). */
    iri: z.string().min(1).optional(),
    columns: z.record(z.string(), OutputMappingSchema).default({}),
  })
  .strict();
export type TableMapping = z.infer<typeof TableMappingSchema>;

/** A recipe-local term, for an output no pinned ontology has a term for. */
export const LocalTermSchema = z
  .object({
    iri: TermRef,
    kind: z.enum([
      'class',
      'object_property',
      'datatype_property',
      'annotation_property',
      'concept',
    ]),
    label: z.string().min(1),
    definition: z.string().optional(),
  })
  .strict();
export type LocalTerm = z.infer<typeof LocalTermSchema>;

/** The recipe's ontology mapping (ADR 0011): validated, versioned and immutable with the recipe. */
export const SemanticsSchema = z
  .object({
    ontologies: z.array(OntologyPinSchema).default([]),
    /** SHACL shapes the document's graph must satisfy (rollout step 5). */
    shapes: z.array(OntologyPinSchema).default([]),
    prefixes: z.record(z.string().regex(/^[A-Za-z][\w-]*$/), z.string().url()).default({}),
    document: z.object({ class: TermRef, iri: z.string().min(1).default('doc/{source}') }).strict(),
    fields: z.record(z.string(), OutputMappingSchema).default({}),
    tables: z.record(z.string(), TableMappingSchema).default({}),
    /** Recipe-local terms, for outputs no pinned ontology has a term for. */
    local: z.array(LocalTermSchema).default([]),
    /** The link, value and unit properties every value node uses unless it gives its own. */
    valueNodes: ValueNodeDefaultsSchema.optional(),
  })
  .strict();
export type Semantics = z.infer<typeof SemanticsSchema>;

/** A value node's effective terms: its own, else the recipe's `valueNodes` defaults. */
export interface ResolvedNode {
  link?: string;
  class: string;
  value?: string;
  unit?: string;
  unitProperty?: string;
}

/**
 * A value node's effective terms; null when the output is not a value node. Held in step with
 * `Semantics.resolve_node` in the worker by the shared fixture `value-nodes.json`.
 */
export function resolveNode(
  semantics: Pick<Semantics, 'valueNodes'>,
  m: OutputMapping,
): ResolvedNode | null {
  if (!m.node) return null;
  const d = semantics.valueNodes ?? {};
  const out: ResolvedNode = { class: m.node.class };
  const link = m.property ?? d.link;
  const value = m.node.value ?? d.value;
  const unitProperty = m.node.unitProperty ?? d.unitProperty;
  if (link !== undefined) out.link = link;
  if (value !== undefined) out.value = value;
  if (m.node.unit !== undefined) out.unit = m.node.unit;
  if (unitProperty !== undefined) out.unitProperty = unitProperty;
  return out;
}

/** The property an output hangs off its document or row by: a value node's resolved link. */
export function linkOf(
  semantics: Pick<Semantics, 'valueNodes'>,
  m: OutputMapping,
): string | undefined {
  return m.node ? (m.property ?? semantics.valueNodes?.link) : m.property;
}

export const DELIVERY_FORMATS = ['csv', 'json', 'rdf'] as const;
export type DeliveryFormat = (typeof DELIVERY_FORMATS)[number];
export const DeliverySchema = z
  .object({
    formats: z.array(z.enum(DELIVERY_FORMATS)).min(1).optional(),
    /** The publishing targets' ids, one or a list (see `publish-targets.ts`); absent = `default`. */
    publishTo: PublishToSchema.optional(),
  })
  .strict();

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
      .prefault({}),
    /** How the recipe's outputs map to ontology terms (absent: no RDF). */
    semantics: SemanticsSchema.optional(),
    /** What publishing delivers (absent: CSV and JSON). */
    delivery: DeliverySchema.optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const fieldIds = t.outputs.fields.map((f) => f.id);
    const tables = new Map(t.outputs.tables.map((tb) => [tb.id, tb]));
    const sectionIds = new Set(t.document.sections.map((s) => s.id));
    const extracts = t.pipeline.filter((s) => s.type === 'extract');
    const fillers = t.pipeline.filter((s) => s.type === 'extract' || s.type === 'plugin');
    const sectionById = new Map(t.document.sections.map((s) => [s.id, s]));
    keyFromIssues(t.document.sections).forEach(({ message }) => issue(message));

    const dupes = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    dupes([...fieldIds, ...tables.keys()]).forEach((d) => issue(`duplicate output id "${d}"`));
    dupes(t.pipeline.map((s) => s.id)).forEach((d) => issue(`duplicate step id "${d}"`));
    [...tables.keys(), ...t.pipeline.filter((s) => s.type === 'check').map((s) => s.id)]
      .filter((id) => RESERVED_OUTPUT_IDS.has(id))
      .forEach((id) => issue(`output id "${id}" is reserved`));

    for (const step of fillers) {
      if (step.fields.length > 0 === (step.table !== undefined)) {
        issue(`step "${step.id}": a step must fill either fields or a table`);
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
      if (step.columns !== undefined) {
        const table = step.table === undefined ? undefined : tables.get(step.table);
        if (step.table === undefined) issue(`step "${step.id}": columns needs a table`);
        for (const c of step.columns) {
          if (table && !table.columns.some((col) => col.id === c)) {
            issue(`step "${step.id}": unknown column "${c}" of ${step.table}`);
          }
        }
        if (step.type === 'extract' && step.chunkPages !== undefined) {
          issue(`step "${step.id}": an enriching step cannot be chunked`);
        }
        if (step.sections.some((s) => sectionById.get(s)?.repeat)) {
          issue(`step "${step.id}": an enriching step cannot read a repeating section`);
        }
        if (step.keyColumn !== undefined) {
          issue(`step "${step.id}": keyColumn is for the step creating the rows`);
        }
      }
      const repeating = step.sections.filter((s) => sectionById.get(s)?.repeat);
      if (step.fields.length > 0 && repeating.length > 0) {
        issue(
          `step "${step.id}": a field step cannot read a repeating section (${repeating[0]}); fill a table instead`,
        );
      }
      if (repeating.length > 1) {
        issue(`step "${step.id}": reads more than one repeating section (${repeating.join(', ')})`);
      }
      if (step.occurrences !== undefined) {
        if (repeating.length === 0) {
          issue(`step "${step.id}": an occurrence filter needs a repeating section`);
        } else if (!patternCompiles(step.occurrences.match)) {
          issue(
            `step "${step.id}": the occurrence filter is not a valid pattern: ${step.occurrences.match}`,
          );
        }
      }
      if (step.keyColumn !== undefined) {
        const section = repeating.length > 0 ? sectionById.get(repeating[0]!) : undefined;
        if (
          step.table === undefined ||
          section === undefined ||
          (section.key === undefined && section.keyFrom === undefined)
        ) {
          issue(`step "${step.id}": keyColumn needs a repeating section with a key or keyFrom`);
        } else {
          const table = tables.get(step.table);
          if (table && !table.columns.some((c) => c.id === step.keyColumn)) {
            issue(
              `step "${step.id}": keyColumn "${step.keyColumn}" is not a column of ${step.table}`,
            );
          }
        }
      }
    }
    for (const step of extracts) {
      if (step.chunkPages !== undefined && step.table === undefined) {
        issue(`step "${step.id}": only table steps can be chunked`);
      }
      if (step.chunkPages !== undefined && step.sections.length !== 1) {
        issue(`step "${step.id}": chunked steps need exactly one section`);
      }
    }
    const order = new Map(t.pipeline.map((s, i) => [s.id, i]));
    const coverage = outputCoverage(t);
    for (const o of coverage.outputs) {
      const { creators, enrichers } =
        o.kind === 'table' ? tableSteps(fillers, o.id) : { creators: [], enrichers: [] };
      if (o.steps.length === 0) {
        issue(
          enrichers.length > 0
            ? `table "${o.id}" has no step creating its rows`
            : `${o.kind} "${o.id}" is not filled by any step`,
        );
      }
      if (o.steps.length > 1) issue(`${o.kind} "${o.id}" is filled by more than one step`);
      const creator = creators.length === 1 ? creators[0]! : undefined;
      if (!creator || enrichers.length === 0) continue;
      if ((o.columns ?? []).every((c) => !c.steps.includes(creator.id))) {
        issue(`step "${creator.id}" creates the rows of ${o.id} but fills none of its columns`);
      }
      for (const e of enrichers) {
        if (order.get(e.id)! < order.get(creator.id)!) {
          issue(`step "${e.id}" enriches ${o.id} before step "${creator.id}" creates its rows`);
        }
      }
    }
    coverage.multiple
      .filter((id) => id.includes('.'))
      .forEach((id) => issue(`column "${id}" is filled by more than one step`));

    const resolves = (path: string) => {
      const [head, column] = path.split('.', 2) as [string, string | undefined];
      if (column === undefined) return fieldIds.includes(head);
      return tables.get(head)?.columns.some((c) => c.id === column) ?? false;
    };
    /** Why a path does not resolve, saying how to fix a bare table id (worker `_unknown_path`). */
    const unknownPath = (path: string) => {
      const table = tables.get(path);
      if (!table) return `unknown field or column "${path}"`;
      const columns = table.columns.map((c) => `${path}.${c.id}`).join(', ');
      return `unknown field or column "${path}": "${path}" is a table, so name one of its columns: ${columns}`;
    };
    const fillerOf = (path: string) => {
      const [head, column] = path.split('.', 2) as [string, string | undefined];
      if (column === undefined) return fillers.find((s) => s.fields.includes(head));
      const { creators, enrichers } = tableSteps(fillers, head);
      return enrichers.find((s) => s.columns!.includes(column)) ?? creators[0];
    };
    for (const step of fillers) {
      for (const [name, path] of Object.entries(step.context)) {
        if (!resolves(path)) {
          issue(`step "${step.id}": context "${name}": ${unknownPath(path)}`);
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
    const formats = t.delivery?.formats ?? [];
    dupes(formats).forEach((f) => issue(`delivery: "${f}" is listed twice`));
    if (formats.includes('rdf') && !t.semantics) {
      issue('delivery: rdf needs an ontology mapping (semantics)');
    }
    if (t.semantics) {
      const semantics = t.semantics;
      const mapping = (label: string, def: z.infer<typeof ValueDefSchema>, m: OutputMapping) => {
        if (m.object && m.concepts) {
          issue(`semantics: ${label}: map it to an entity or to concepts, not both`);
        }
        if (!m.node && m.property === undefined) {
          issue(`semantics: ${label}: a property is required`);
        }
        const node = resolveNode(semantics, m);
        if (node) {
          if (m.object || m.concepts) {
            issue(`semantics: ${label}: a value node cannot also be an entity or concepts`);
          }
          if (node.link === undefined) {
            issue(
              `semantics: ${label}: a value node needs a link: give its property or set semantics.valueNodes.link`,
            );
          }
          if (node.value === undefined) {
            issue(
              `semantics: ${label}: a value node needs a value property: give node.value or set semantics.valueNodes.value`,
            );
          }
          if (node.unit !== undefined && node.unitProperty === undefined) {
            issue(
              `semantics: ${label}: a unit needs a unit property: give node.unitProperty or set semantics.valueNodes.unitProperty`,
            );
          }
          if (def.type === 'list') {
            issue(
              `semantics: ${label}: a list cannot be a value node: map its items as literals, entities or concepts`,
            );
          }
        }
        if (def.type === 'enum' && m.concepts?.values) {
          Object.keys(m.concepts.values)
            .filter((v) => !(def.enum ?? []).includes(v))
            .forEach((v) => issue(`semantics: ${label}: "${v}" is not one of its values`));
        }
      };
      for (const [id, m] of Object.entries(t.semantics.fields)) {
        const def = t.outputs.fields.find((f) => f.id === id);
        if (def) mapping(`field "${id}"`, def, m);
        else issue(`semantics: unknown field "${id}"`);
      }
      for (const [id, tm] of Object.entries(t.semantics.tables)) {
        const table = tables.get(id);
        if (!table) {
          issue(`semantics: unknown table "${id}"`);
          continue;
        }
        for (const [cid, m] of Object.entries(tm.columns)) {
          const def = table.columns.find((c) => c.id === cid);
          if (def) mapping(`column "${id}.${cid}"`, def, m);
          else issue(`semantics: table "${id}": unknown column "${cid}"`);
        }
      }
    }
    for (const step of t.pipeline) {
      if (step.type !== 'check') continue;
      // A plugin check resolves only its values; `reference` and `aliases` belong to the other kind.
      [step.values, step.reference, step.aliases]
        .filter((p): p is string => p !== undefined && !resolves(p))
        .forEach((p) => issue(`check "${step.id}": ${unknownPath(p)}`));
    }
  });

export type Template = z.infer<typeof TemplateSchema>;

/**
 * The model an extract step runs (before any job override): its own, else the template's,
 * else the default choice. Held in step with `Template.step_model` in the worker.
 */
export function stepModel(
  template: Pick<Template, 'model'>,
  step: { model?: string | undefined },
): string {
  return step.model !== undefined && step.model !== 'default'
    ? step.model
    : (template.model ?? 'default');
}

/** What publishing delivers. Held in step with `Template.delivery_formats` in the worker. */
export function deliveryFormats(template: Pick<Template, 'delivery'>): DeliveryFormat[] {
  return template.delivery?.formats ?? ['csv', 'json'];
}

/**
 * Where a recipe's outputs go, as the Workbench Outputs tab switches them: `s3` is the CSV and
 * JSON written to the target bucket, `rdf` the graph published to the triple store.
 */
export const DELIVERY_TARGETS = ['s3', 'rdf'] as const;
export type DeliveryTarget = (typeof DELIVERY_TARGETS)[number];

const TARGET_FORMATS: Record<DeliveryTarget, readonly DeliveryFormat[]> = {
  s3: ['csv', 'json'],
  rdf: ['rdf'],
};

type LooseDefinition = Record<string, unknown>;

function formatsOf(definition: LooseDefinition): DeliveryFormat[] {
  const delivery = definition.delivery as { formats?: DeliveryFormat[] } | undefined;
  return delivery?.formats ?? ['csv', 'json'];
}

/**
 * Which targets a (possibly invalid) draft definition has on. RDF counts as on while the recipe
 * has an ontology mapping it does not deliver yet, so turning it off removes that mapping.
 */
export function deliveryTargets(definition: LooseDefinition): Record<DeliveryTarget, boolean> {
  const formats = formatsOf(definition);
  return {
    s3: formats.some((f) => TARGET_FORMATS.s3.includes(f)),
    rdf: formats.includes('rdf') || definition.semantics !== undefined,
  };
}

/**
 * The definition with one target switched (pure). RDF off also deletes the ontology mapping
 * (`semantics`); the default (CSV and JSON) is written as no `delivery` at all, as the recipe
 * editor's General tab does. Throws rather than turn off the last target.
 */
export function setDeliveryTarget(
  definition: LooseDefinition,
  target: DeliveryTarget,
  on: boolean,
): LooseDefinition {
  const targets = { ...deliveryTargets(definition), [target]: on };
  if (!targets.s3 && !targets.rdf) throw new Error('at least one output stays on');
  const formats = DELIVERY_FORMATS.filter((f) =>
    f === 'rdf' ? targets.rdf : target === 's3' ? on : formatsOf(definition).includes(f),
  );
  const next: LooseDefinition = { ...definition };
  const publishTo = (definition.delivery as { publishTo?: PublishTo } | undefined)?.publishTo;
  delete next.delivery;
  if (target === 'rdf' && !on) delete next.semantics;
  const isDefault = formats.join() === 'csv,json';
  if (isDefault && publishTo === undefined) return next;
  return {
    ...next,
    delivery: {
      ...(isDefault ? {} : { formats }),
      ...(publishTo === undefined ? {} : { publishTo }),
    },
  };
}
