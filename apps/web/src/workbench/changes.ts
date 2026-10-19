import {
  stableJson,
  type DraftChange,
  type ModelChoice,
  type OutputMapping,
  type ValueNodeDefaults,
} from '@ih/shared';
import { modelDisplayName } from '../jobs/derive.js';

export type ChangeKind =
  | 'FIELD'
  | 'TABLE'
  | 'SECTION'
  | 'COPIES'
  | 'EXTRACT'
  | 'CHECK'
  | 'PLUGIN'
  | 'REMOVE'
  | 'PREAMBLE'
  | 'MAPPING'
  | 'TERM';

/** What an output maps to, in a few words: the property, then an entity, concepts or a node. */
function mappingText(m: OutputMapping): string {
  if (m.node) {
    const node = [
      `node of ${m.node.class}`,
      ...(m.node.value ? [`value ${m.node.value}`] : []),
      ...(m.node.unit ? [`unit ${m.node.unit}`] : []),
    ].join(' · ');
    return m.property ? `${m.property} → ${node}` : node;
  }
  if (m.object) return `${m.property} → ${m.object.class} (${m.object.iri})`;
  if (m.concepts) {
    const values = Object.entries(m.concepts.values ?? {});
    return values.length
      ? `${m.property} → ${values.map(([v, t]) => `${v}=${t}`).join(', ')}`
      : `${m.property} → concepts of ${m.concepts.scheme ?? '(no scheme)'}`;
  }
  return m.property ?? '';
}

/** The value-node defaults a document change sets, in a few words; '' when it sets none. */
function valueNodesText(d: ValueNodeDefaults | undefined): string {
  const parts = [
    ...(d?.link ? [`link ${d.link}`] : []),
    ...(d?.value ? [`value ${d.value}`] : []),
    ...(d?.unitProperty ? [`unit ${d.unitProperty}`] : []),
  ];
  return parts.length ? ` · value nodes: ${parts.join(', ')}` : '';
}

/** A change as the proposal card shows it: kind tag, tone, id (mono) and the rest in words. */
export function changeParts(c: DraftChange): {
  kind: ChangeKind;
  tone: 'info' | 'neutral' | 'ok' | 'danger';
  id: string | null;
  text: string;
} {
  switch (c.op) {
    case 'putField':
      return {
        kind: 'FIELD',
        tone: 'ok',
        id: c.field.id,
        text: c.field.type === 'enum' ? `enum: ${(c.field.enum ?? []).join(', ')}` : c.field.type,
      };
    case 'putTable':
      return {
        kind: 'TABLE',
        tone: 'ok',
        id: c.table.id,
        text: `columns ${c.table.columns.map((col) => col.id).join(', ')}`,
      };
    case 'removeOutput':
      return { kind: 'REMOVE', tone: 'danger', id: c.id, text: 'remove this output' };
    case 'putSection':
      return {
        kind: 'SECTION',
        tone: 'info',
        id: c.section.id,
        text: `/${c.section.anchor}/${c.section.required ? '' : ' (optional)'}`,
      };
    case 'removeSection':
      return { kind: 'REMOVE', tone: 'danger', id: c.id, text: 'remove this section' };
    case 'setCopies':
      return {
        kind: 'COPIES',
        tone: 'neutral',
        id: null,
        text: c.copies
          ? `Keep the ${c.copies.select} copy, split at /${c.copies.anchor}/`
          : 'No copy selection',
      };
    case 'putStep':
      if (c.step.type === 'plugin') {
        const fills = c.step.table ? `table ${c.step.table}` : c.step.fields.join(', ');
        const reads = c.step.sections.length ? ` from ${c.step.sections.join(', ')}` : '';
        return {
          kind: 'PLUGIN',
          tone: 'info',
          id: c.step.id,
          text: `runs ${c.step.uses}, fills ${fills}${reads}`,
        };
      }
      return c.step.type === 'extract'
        ? {
            kind: 'EXTRACT',
            tone: 'info',
            id: c.step.id,
            text: `fills ${c.step.table ? `table ${c.step.table}` : c.step.fields.join(', ')} from ${c.step.sections.join(', ')}`,
          }
        : {
            kind: 'CHECK',
            tone: 'neutral',
            id: c.step.id,
            text: `${c.step.values} against ${c.step.reference}`,
          };
    case 'removeStep':
      return { kind: 'REMOVE', tone: 'danger', id: c.id, text: 'remove this step' };
    case 'setPreamble':
      return {
        kind: 'PREAMBLE',
        tone: 'neutral',
        id: null,
        text: c.preamble ? 'Set the prompt preamble' : 'Remove the prompt preamble',
      };
    case 'setDocumentMapping':
      return {
        kind: 'MAPPING',
        tone: 'info',
        id: 'document',
        text: `${c.document.class} · ${c.ontologies.map((o) => `${o.id} v${o.version}`).join(', ') || 'no ontology'}${valueNodesText(c.valueNodes)}`,
      };
    case 'putFieldMapping':
      return { kind: 'MAPPING', tone: 'ok', id: c.field, text: mappingText(c.mapping) };
    case 'putTableMapping':
      return {
        kind: 'MAPPING',
        tone: 'ok',
        id: c.table,
        text: `${c.mapping.link} → ${c.mapping.class}; ${Object.entries(c.mapping.columns)
          .map(([col, m]) => `${col}: ${mappingText(m)}`)
          .join(', ')}`,
      };
    case 'removeMapping':
      return { kind: 'REMOVE', tone: 'danger', id: c.id, text: 'remove this mapping' };
    case 'putLocalTerm':
      return {
        kind: 'TERM',
        tone: 'neutral',
        id: c.term.iri,
        text: `${c.term.kind.replace('_', ' ')} "${c.term.label}"`,
      };
  }
}

/** One line per change for assistive technology (a checkbox label): kind, id and the words. */
export function changeLabel(c: DraftChange): string {
  const parts = changeParts(c);
  return [parts.kind, parts.id, parts.text].filter(Boolean).join(' ');
}

export type ChangeVerb = 'NEW' | 'CHANGED' | 'REMOVED';

type Def = Record<string, unknown>;
const MINUS = '−';
const obj = (v: unknown): Def =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Def) : {};
const list = (v: unknown): Def[] => (Array.isArray(v) ? v.map(obj) : []);
const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const shown = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '–');
const same = (a: unknown, b: unknown) => stableJson(a ?? null) === stableJson(b ?? null);
const arrow = (label: string, a: unknown, b: unknown) =>
  same(a, b) ? [] : [`${label} ${shown(a)} → ${shown(b)}`];
const edited = (key: string, a: unknown, b: unknown) => (same(a, b) ? [] : [`${key} edited`]);
const setDiff = (before: string[], after: string[], label = '') => [
  ...after.filter((x) => !before.includes(x)).map((x) => `+ ${label}${x}`),
  ...before.filter((x) => !after.includes(x)).map((x) => `${MINUS} ${label}${x}`),
];
const modelName = (v: unknown, choices: readonly ModelChoice[]) =>
  typeof v === 'string' ? modelDisplayName(v, choices) : v;
const withDefault = (v: unknown, fallback: unknown) => (v === undefined ? fallback : v);

/** The item a change replaces in the draft, or null when it adds one. */
function existing(c: DraftChange, def: Def): Def | null {
  const outputs = obj(def.outputs);
  const document = obj(def.document);
  const find = (items: Def[], id: string) => items.find((x) => x.id === id) ?? null;
  switch (c.op) {
    case 'putField':
      return find([...list(outputs.fields), ...list(outputs.tables)], c.field.id);
    case 'putTable':
      return find([...list(outputs.fields), ...list(outputs.tables)], c.table.id);
    case 'putSection':
      return find(list(document.sections), c.section.id);
    case 'putStep':
      return find(list(def.pipeline), c.step.id);
    case 'setCopies':
      return document.copies ? obj(document.copies) : null;
    case 'setPreamble':
      return typeof def.preamble === 'string' && def.preamble !== '' ? {} : null;
    default:
      return null;
  }
}

/** NEW / CHANGED / REMOVED against the open draft (handoff §0.2). */
export function changeVerb(c: DraftChange, definition: Def): ChangeVerb {
  if (c.op === 'removeOutput' || c.op === 'removeSection' || c.op === 'removeStep')
    return 'REMOVED';
  if (c.op === 'setCopies' && c.copies === null) return 'REMOVED';
  if (c.op === 'setPreamble' && c.preamble === '') return 'REMOVED';
  return existing(c, definition) === null ? 'NEW' : 'CHANGED';
}

function valueDiff(before: Def, after: Def): string[] {
  return [
    ...arrow('type', withDefault(before.type, 'text'), withDefault(after.type, 'text')),
    ...(same(before.enum, after.enum)
      ? []
      : [`values ${ids(before.enum).join(', ') || '–'} → ${ids(after.enum).join(', ') || '–'}`]),
    ...edited('name', before.name, after.name),
    ...edited('description', before.description, after.description),
  ];
}

/** The mono diff chip of a change: what it adds, drops or moves; null when there is nothing to add. */
export function changeDiff(
  c: DraftChange,
  definition: Def,
  choices: readonly ModelChoice[],
): string | null {
  if (c.op === 'removeOutput' || c.op === 'removeSection' || c.op === 'removeStep') {
    return `${MINUS} ${c.id}`;
  }
  if (c.op === 'setCopies' || c.op === 'setPreamble') return null;
  if (
    c.op === 'setDocumentMapping' ||
    c.op === 'putFieldMapping' ||
    c.op === 'putTableMapping' ||
    c.op === 'removeMapping' ||
    c.op === 'putLocalTerm'
  ) {
    return null; // the mapping card shows the term itself
  }
  const before = existing(c, definition);
  const id =
    c.op === 'putField'
      ? c.field.id
      : c.op === 'putTable'
        ? c.table.id
        : c.op === 'putSection'
          ? c.section.id
          : c.step.id;
  if (before === null) return `+ ${id}`;
  let parts: string[] = [];
  if (c.op === 'putField') parts = valueDiff(before, c.field as Def);
  if (c.op === 'putTable') {
    const old = list(before.columns);
    const now = c.table.columns as Def[];
    parts = [
      ...setDiff(
        old.map((x) => String(x.id)),
        now.map((x) => String(x.id)),
      ),
      ...now
        .filter((col) => {
          const prev = old.find((x) => x.id === col.id);
          return prev !== undefined && valueDiff(prev, col).length > 0;
        })
        .map((col) => `~ ${String(col.id)}`),
      ...edited('name', before.name, c.table.name),
      ...edited('description', before.description, c.table.description),
    ];
  }
  if (c.op === 'putSection') {
    const was = withDefault(before.required, true) === true;
    parts = [
      ...(same(before.anchor, c.section.anchor)
        ? []
        : [`anchor /${shown(before.anchor)}/ → /${c.section.anchor}/`]),
      ...(was === c.section.required ? [] : [was ? 'required → optional' : 'optional → required']),
    ];
  }
  if (c.op === 'putStep') {
    const step = c.step as Def;
    if (before.type !== step.type) {
      parts = [`type ${shown(before.type)} → ${shown(step.type)}`];
    } else if (step.type === 'plugin') {
      parts = [
        ...arrow('plugin', before.uses, step.uses),
        ...setDiff(ids(before.fields), ids(step.fields)),
        ...arrow('table', before.table, step.table),
        ...setDiff(ids(before.sections), ids(step.sections), 'reads '),
        ...(JSON.stringify(before.with ?? {}) === JSON.stringify(step.with ?? {})
          ? []
          : ['settings edited']),
      ];
    } else if (step.type === 'extract') {
      parts = [
        ...setDiff(ids(before.fields), ids(step.fields)),
        ...arrow('table', before.table, step.table),
        ...setDiff(ids(before.sections), ids(step.sections), 'reads '),
        ...arrow('chunk pages', before.chunkPages, step.chunkPages),
        ...arrow(
          'model',
          modelName(withDefault(before.model, 'default'), choices),
          modelName(withDefault(step.model, 'default'), choices),
        ),
        ...arrow('attempts', withDefault(before.maxAttempts, 2), withDefault(step.maxAttempts, 2)),
        ...edited('instructions', before.instructions, step.instructions),
      ];
    } else {
      parts = [
        ...arrow('values', before.values, step.values),
        ...arrow('reference', before.reference, step.reference),
        ...arrow('aliases', before.aliases, step.aliases),
      ];
    }
  }
  return parts.length ? parts.join(', ') : null;
}

const REF_LIKE = /^[\w.-]+(\/[\w.:-]+)+$/;

/**
 * A stored change chip (`describeDefinitionChange`, server side) with model values by name. The
 * chip carries no path, so a scalar `a → b` is read as a model change when a side is `draft`, a
 * choice id or an `endpoint/model` ref; the sides then show as choice labels ("Model no longer
 * offered" for a name no choice has). Any other chip is returned as it is.
 */
export function modelsInChip(chip: string, choices: readonly ModelChoice[]): string {
  const m = /^(\S+) → (\S+)$/.exec(chip);
  if (!m) return chip;
  const [, from, to] = m as unknown as [string, string, string];
  const definite = (v: string) =>
    v === 'draft' || REF_LIKE.test(v) || choices.some((c) => c.id === v);
  if (!definite(from) && !definite(to)) return chip;
  return `${modelDisplayName(from, choices)} → ${modelDisplayName(to, choices)}`;
}
