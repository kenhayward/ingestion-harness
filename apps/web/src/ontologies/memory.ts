import type {
  MappingMemoryEntry,
  MemoryStatus,
  MemoryTermLabels,
  RememberedAnswer,
} from '@ih/shared';

/** The last segment of an IRI (after `#` or `/`), for a term the library does not name. */
export const localName = (iri: string): string => iri.split(/[#/]/).filter(Boolean).at(-1) ?? iri;

const name = (labels: MemoryTermLabels, iri: string): string =>
  labels[iri]?.label ?? localName(iri);

/** A remembered answer in words: term labels, never raw IRIs. */
export function answerInWords(answer: RememberedAnswer, labels: MemoryTermLabels): string {
  switch (answer.form) {
    case 'unmapped':
      return 'Left unmapped';
    case 'node':
      return `Value node of ${name(labels, answer.class)}${answer.unit ? `, in ${localName(answer.unit)}` : ''}`;
    case 'literal':
      return `Value of ${name(labels, answer.property)}`;
    case 'entity':
      return `Entity of ${name(labels, answer.class)}, linked by ${name(labels, answer.property)}`;
    case 'concept':
      return answer.scheme
        ? `Concept from ${name(labels, answer.scheme)}, linked by ${name(labels, answer.property)}`
        : `Concept, linked by ${name(labels, answer.property)}`;
    case 'table':
      return `Rows of ${name(labels, answer.class)}, linked by ${name(labels, answer.link)}`;
    case 'document':
      return `Document of ${name(labels, answer.class)}`;
    case 'valueNodes':
      return 'Value-node defaults';
  }
}

export const STATUS_LABEL: Record<MemoryStatus, string> = {
  learned: 'Learned',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
};

export const KIND_WORD: Record<MappingMemoryEntry['kind'], string> = {
  document: 'Document',
  field: 'Field',
  column: 'Column',
  table: 'Table',
};

/** The term keys each answer form edits (the unit is an IRI typed in, not looked up). */
export const ANSWER_FIELDS: Record<
  RememberedAnswer['form'],
  { key: string; label: string; want: 'property' | 'class' | 'scheme' | null }[]
> = {
  literal: [{ key: 'property', label: 'Property', want: 'property' }],
  entity: [
    { key: 'property', label: 'Property', want: 'property' },
    { key: 'class', label: 'Class', want: 'class' },
    { key: 'iri', label: 'IRI template', want: null },
  ],
  concept: [
    { key: 'property', label: 'Property', want: 'property' },
    { key: 'scheme', label: 'Scheme', want: 'scheme' },
  ],
  node: [
    { key: 'class', label: 'Class', want: 'class' },
    { key: 'link', label: 'Link', want: 'property' },
    { key: 'value', label: 'Value property', want: 'property' },
    { key: 'unit', label: 'Unit', want: null },
    { key: 'unitProperty', label: 'Unit property', want: 'property' },
  ],
  table: [
    { key: 'link', label: 'Link', want: 'property' },
    { key: 'class', label: 'Row class', want: 'class' },
  ],
  document: [
    { key: 'class', label: 'Class', want: 'class' },
    { key: 'iri', label: 'IRI template', want: null },
  ],
  valueNodes: [
    { key: 'link', label: 'Link', want: 'property' },
    { key: 'value', label: 'Value property', want: 'property' },
    { key: 'unitProperty', label: 'Unit property', want: 'property' },
  ],
  unmapped: [],
};

/** The answer a form's fields make (empty fields left out). */
export function answerFrom(
  form: RememberedAnswer['form'],
  values: Record<string, string>,
  keep: Partial<RememberedAnswer> = {},
): RememberedAnswer {
  const out: Record<string, unknown> = { form };
  for (const [k, v] of Object.entries(keep)) {
    if (k !== 'form' && !ANSWER_FIELDS[form].some((f) => f.key === k)) out[k] = v;
  }
  for (const f of ANSWER_FIELDS[form]) {
    const v = (values[f.key] ?? '').trim();
    if (v) out[f.key] = v;
  }
  return out as RememberedAnswer;
}
