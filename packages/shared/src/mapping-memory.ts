import { z } from 'zod';
import { stableJson } from './drafting.js';
import {
  CURIE_PREFIXES,
  SemanticsSchema,
  resolveNode,
  type OutputMapping,
  type Semantics,
} from './template.js';

/**
 * Mapping memory (docs/design/mapping-memory.md): the ontology mappings designers accepted, kept
 * deployment-wide and offered again for outputs that look the same. This module is the contract
 * both sides share: the signature normaliser (held in step with the worker's
 * `mapping_memory.signature_of` by `test/fixtures/mapping-signature.json`) and the remembered
 * answer (`test/fixtures/remembered-answers.json`).
 */

/** Names that mean nothing without their table: their signature carries the table's name. */
export const GENERIC_NAMES: readonly string[] = [
  'average',
  'comment',
  'comments',
  'count',
  'max',
  'maximum',
  'mean',
  'min',
  'minimum',
  'notes',
  'other',
  'remarks',
  'result',
  'results',
  'rsd',
  'sd',
  'total',
  'value',
  'values',
];

/** Unit spellings recognised in an output's name or description, and their canonical form. */
export const UNIT_SPELLINGS: Readonly<Record<string, string>> = {
  '%': '%',
  percent: '%',
  mg: 'mg',
  g: 'g',
  kg: 'kg',
  ug: 'µg',
  µg: 'µg',
  ml: 'ml',
  l: 'l',
  'mg/g': 'mg/g',
  'mg/ml': 'mg/ml',
  'ug/ml': 'µg/ml',
  'µg/ml': 'µg/ml',
  cfu: 'cfu',
  'cfu/g': 'cfu/g',
  'cfu/ml': 'cfu/ml',
  ppm: 'ppm',
  ppb: 'ppb',
  min: 'min',
  minutes: 'min',
  h: 'h',
  hours: 'h',
  days: 'day',
  day: 'day',
  months: 'month',
  month: 'month',
  '°c': '°c',
  degc: '°c',
  nm: 'nm',
  mm: 'mm',
};

/** Unit words that may end a name without parentheses (`storage_time_months`, `Assay %`). */
export const TRAILING_UNITS: readonly string[] = [
  '%',
  'percent',
  'minutes',
  'min',
  'hours',
  'days',
  'months',
];

export type SignatureKind = 'document' | 'field' | 'column' | 'table';

export interface SignatureInput {
  kind: SignatureKind;
  name: string;
  description?: string | null;
  type?: string | null;
  /** A column's table name (used only when the column's name is generic). */
  table?: string | null;
}

export interface Signature {
  /** What remembered answers are matched on. */
  key: string;
  /** The name as words (lower case, units taken out). */
  words: string;
  /** The canonical unit found in the name or description, else "". */
  unit: string;
  /** The name is generic, so the key carries the table's name. */
  generic: boolean;
}

/** Lower-case words: camelCase and snake_case split, punctuation as spaces (`%` and `/` kept). */
function wordsOf(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9%/µ°]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function unitIn(text: string): { unit: string; rest: string } {
  for (const m of text.matchAll(/\(([^()]*)\)/g)) {
    const unit = UNIT_SPELLINGS[m[1]!.trim().toLowerCase()];
    if (unit) return { unit, rest: text.replace(m[0], ' ') };
  }
  return { unit: '', rest: text };
}

function typeGroup(type: string | null | undefined): string {
  const t = (type ?? '').toLowerCase();
  if (['number', 'integer', 'decimal', 'float'].includes(t)) return 'number';
  if (['date', 'datetime', 'time'].includes(t)) return 'date';
  if (t === 'boolean') return 'boolean';
  return 'text';
}

/** An output's signature: what it looks like, independent of the recipe it is in. */
export function signatureOf(input: SignatureInput): Signature {
  let { unit, rest } = unitIn(input.name);
  let words = wordsOf(rest);
  if (!unit) {
    const parts = words.split(' ');
    const last = parts[parts.length - 1] ?? '';
    if (parts.length > 1 && TRAILING_UNITS.includes(last)) {
      unit = UNIT_SPELLINGS[last]!;
      words = parts.slice(0, -1).join(' ');
    }
  }
  if (!unit && input.description) unit = unitIn(input.description).unit;
  const group = input.kind === 'document' ? 'document' : input.kind === 'table' ? 'table' : 'value';
  const generic = group === 'value' && GENERIC_NAMES.includes(words);
  const types = group === 'value' ? typeGroup(input.type) : '';
  const table = generic && input.table ? wordsOf(input.table) : '';
  const key = [group, words, types, unit, ...(generic ? [table] : [])].join('|');
  return { key, words, unit, generic };
}

const Iri = z.string().min(1);

/** What was accepted for an output: its form and terms, every term a full IRI. */
export const RememberedAnswerSchema = z.discriminatedUnion('form', [
  z.object({ form: z.literal('literal'), property: Iri }).strict(),
  z
    .object({
      form: z.literal('entity'),
      property: Iri,
      class: Iri,
      iri: z.string().min(1),
      label: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      form: z.literal('concept'),
      property: Iri,
      scheme: Iri.optional(),
      values: z.record(z.string(), Iri).optional(),
      match: z.literal('label').optional(),
    })
    .strict(),
  z
    .object({
      form: z.literal('node'),
      link: Iri.optional(),
      class: Iri,
      value: Iri.optional(),
      unit: Iri.optional(),
      unitProperty: Iri.optional(),
    })
    .strict(),
  /** Left unmapped in a recipe with a mapping: hinted, never pre-selected. */
  z.object({ form: z.literal('unmapped') }).strict(),
  z
    .object({ form: z.literal('table'), link: Iri, class: Iri, iri: z.string().optional() })
    .strict(),
  z.object({ form: z.literal('document'), class: Iri, iri: z.string().min(1) }).strict(),
  /** A recipe's value-node defaults, remembered for the same set of ontologies. */
  z
    .object({
      form: z.literal('valueNodes'),
      link: Iri.optional(),
      value: Iri.optional(),
      unitProperty: Iri.optional(),
    })
    .strict(),
]);
export type RememberedAnswer = z.infer<typeof RememberedAnswerSchema>;

/** The answer's identity: equal keys are the same answer. */
export const answerKey = (answer: RememberedAnswer): string => stableJson(answer);

/** The IRIs an answer uses (to check them against the library). */
export function answerTerms(answer: RememberedAnswer): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(answer)) {
    if (['form', 'iri', 'label', 'match', 'unit'].includes(k)) continue;
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') out.push(...Object.values(v as Record<string, string>));
  }
  return [...new Set(out)];
}

/** One output of a recipe and the answer its mapping gives it. */
export interface RecipeAnswer {
  /** `""` the document, a field id, a table id, `table.column`, or `#valueNodes`. */
  path: string;
  signature: SignatureInput;
  answer: RememberedAnswer;
  /** The pinned ontology ids the answer was given under. */
  ontologies: string[];
}

/** The path of a recipe's value-node defaults (keyed by its pinned ontologies). */
export const VALUE_NODE_DEFAULTS_PATH = '#valueNodes';

function expand(term: string | undefined, prefixes: Record<string, string>): string | undefined {
  if (!term) return undefined;
  const [prefix, ...rest] = term.split(':');
  const local = rest.join(':');
  if (rest.length && prefix && prefix in prefixes && !local.startsWith('//')) {
    return prefixes[prefix] + local;
  }
  return /^[a-z][a-z0-9+.-]*:/i.test(term) ? term : undefined;
}

interface OutputDef {
  id: string;
  name?: string;
  description?: string;
  type?: string;
  columns?: OutputDef[];
}

function outputAnswer(
  m: OutputMapping | undefined,
  semantics: Pick<Semantics, 'valueNodes'>,
  prefixes: Record<string, string>,
): RememberedAnswer | null {
  if (!m) return { form: 'unmapped' };
  const x = (t: string | undefined) => expand(t, prefixes);
  const node = resolveNode(semantics, m);
  const strip = <T extends Record<string, unknown>>(o: T) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  if (node) {
    const cls = x(node.class);
    if (!cls) return null;
    return strip({
      form: 'node' as const,
      link: x(node.link),
      class: cls,
      value: x(node.value),
      unit: x(node.unit),
      unitProperty: x(node.unitProperty),
    });
  }
  const property = x(m.property);
  if (!property) return null;
  if (m.object) {
    const cls = x(m.object.class);
    if (!cls) return null;
    return strip({
      form: 'entity' as const,
      property,
      class: cls,
      iri: m.object.iri,
      label: m.object.label,
    });
  }
  if (m.concepts) {
    const values = m.concepts.values
      ? Object.fromEntries(
          Object.entries(m.concepts.values).flatMap(([k, v]) => {
            const iri = x(v);
            return iri ? [[k, iri]] : [];
          }),
        )
      : undefined;
    return strip({
      form: 'concept' as const,
      property,
      scheme: x(m.concepts.scheme),
      values,
      match: m.concepts.match,
    });
  }
  return { form: 'literal', property };
}

/**
 * A recipe's answers: one per output path (an output the mapping leaves out is `unmapped`), the
 * document's class and the value-node defaults. Empty when the recipe has no valid mapping.
 */
export function answersOf(definition: Record<string, unknown>): RecipeAnswer[] {
  const parsed = SemanticsSchema.safeParse(definition.semantics);
  if (!parsed.success) return [];
  const semantics = parsed.data;
  const prefixes = { ...CURIE_PREFIXES, ...semantics.prefixes };
  const ontologies = [...new Set(semantics.ontologies.map((o) => o.id))].sort();
  const outputs = (definition.outputs ?? {}) as { fields?: OutputDef[]; tables?: OutputDef[] };
  const out: RecipeAnswer[] = [];
  const push = (path: string, signature: SignatureInput, answer: RememberedAnswer | null) => {
    if (answer)
      out.push({ path, signature, answer: RememberedAnswerSchema.parse(answer), ontologies });
  };
  const docClass = expand(semantics.document.class, prefixes);
  push(
    '',
    { kind: 'document', name: String(definition.name ?? definition.id ?? 'document') },
    docClass ? { form: 'document', class: docClass, iri: semantics.document.iri } : null,
  );
  for (const f of outputs.fields ?? []) {
    push(
      f.id,
      { kind: 'field', name: f.name ?? f.id, description: f.description, type: f.type },
      outputAnswer(semantics.fields[f.id], semantics, prefixes),
    );
  }
  for (const t of outputs.tables ?? []) {
    const tm = semantics.tables[t.id];
    const link = expand(tm?.link, prefixes);
    const cls = expand(tm?.class, prefixes);
    push(
      t.id,
      { kind: 'table', name: t.name ?? t.id, description: t.description },
      !tm
        ? { form: 'unmapped' }
        : link && cls
          ? { form: 'table', link, class: cls, ...(tm.iri ? { iri: tm.iri } : {}) }
          : null,
    );
    for (const c of t.columns ?? []) {
      push(
        `${t.id}.${c.id}`,
        {
          kind: 'column',
          name: c.name ?? c.id,
          description: c.description,
          type: c.type,
          table: t.name ?? t.id,
        },
        tm ? outputAnswer(tm.columns[c.id], semantics, prefixes) : { form: 'unmapped' },
      );
    }
  }
  if (semantics.valueNodes) {
    const v = semantics.valueNodes;
    const defaults = {
      form: 'valueNodes' as const,
      ...(expand(v.link, prefixes) ? { link: expand(v.link, prefixes) } : {}),
      ...(expand(v.value, prefixes) ? { value: expand(v.value, prefixes) } : {}),
      ...(expand(v.unitProperty, prefixes)
        ? { unitProperty: expand(v.unitProperty, prefixes) }
        : {}),
    };
    if (Object.keys(defaults).length > 1) {
      push(VALUE_NODE_DEFAULTS_PATH, { kind: 'document', name: ontologies.join(' ') }, defaults);
    }
  }
  return out;
}

/** How a remembered answer stands; `stale` is derived (a term missing or deprecated). */
export const MEMORY_STATUSES = ['learned', 'confirmed', 'rejected'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** One remembered mapping, as the Ontologies page lists it. */
export const MappingMemoryEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(['document', 'field', 'column', 'table']),
  signatureKey: z.string(),
  name: z.string().describe('The wording of the output it was accepted for.'),
  description: z.string(),
  type: z.string(),
  unit: z.string(),
  answer: RememberedAnswerSchema,
  ontologies: z.array(z.string()),
  status: z.enum(MEMORY_STATUSES),
  stale: z
    .string()
    .nullable()
    .describe(
      'Why a term no longer holds (missing or deprecated in its newest version); null when fine.',
    ),
  votes: z.number().int().describe('Recipes whose mapping uses this answer for such an output.'),
  refusals: z
    .number()
    .int()
    .describe('Recipes where a designer chose otherwise when it was offered.'),
  recipes: z.array(z.object({ id: z.string(), path: z.string(), version: z.number().int() })),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  note: z.string().nullable(),
  updatedAt: z.string(),
});
export type MappingMemoryEntry = z.infer<typeof MappingMemoryEntrySchema>;

/** A page of entries and the filter counts. */
export const MappingMemoryPageSchema = z.object({
  entries: z.array(MappingMemoryEntrySchema),
  total: z.number().int(),
});
export type MappingMemoryPage = z.infer<typeof MappingMemoryPageSchema>;

export const MemoryListQuerySchema = z.object({
  q: z.string().optional(),
  ontology: z.string().optional(),
  status: z.enum(['review', 'confirmed', 'rejected', 'all']).optional(),
  term: z.string().optional().describe('Only entries that use this IRI.'),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});
export type MemoryListQuery = z.infer<typeof MemoryListQuerySchema>;

/** Adding a mapping by hand on the Ontologies page (it starts confirmed). */
export const MemoryCreateBodySchema = z
  .object({
    kind: z.enum(['field', 'column', 'table', 'document']),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    type: z.string().max(40).optional(),
    table: z.string().max(200).optional(),
    answer: RememberedAnswerSchema,
    note: z.string().max(2000).optional(),
  })
  .strict();
export type MemoryCreateBody = z.infer<typeof MemoryCreateBodySchema>;

/** Confirming, rejecting or editing an entry (an edited answer is confirmed). */
export const MemoryPatchBodySchema = z
  .object({
    status: z.enum(MEMORY_STATUSES).optional(),
    answer: RememberedAnswerSchema.optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type MemoryPatchBody = z.infer<typeof MemoryPatchBodySchema>;
