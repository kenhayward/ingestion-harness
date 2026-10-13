import type { DraftChange } from '@ih/shared';

export type ChangeKind =
  'FIELD' | 'TABLE' | 'SECTION' | 'COPIES' | 'EXTRACT' | 'CHECK' | 'REMOVE' | 'PREAMBLE';

/** A change as the proposal card shows it: kind tag, tone, id (mono) and the rest in words. */
export function changeParts(c: DraftChange): {
  kind: ChangeKind;
  tone: 'info' | 'neutral' | 'ok' | 'alert';
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
      return { kind: 'REMOVE', tone: 'alert', id: c.id, text: 'remove this output' };
    case 'putSection':
      return {
        kind: 'SECTION',
        tone: 'info',
        id: c.section.id,
        text: `/${c.section.anchor}/${c.section.required ? '' : ' (optional)'}`,
      };
    case 'removeSection':
      return { kind: 'REMOVE', tone: 'alert', id: c.id, text: 'remove this section' };
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
      return { kind: 'REMOVE', tone: 'alert', id: c.id, text: 'remove this step' };
    case 'setPreamble':
      return {
        kind: 'PREAMBLE',
        tone: 'neutral',
        id: null,
        text: c.preamble ? 'Set the prompt preamble' : 'Remove the prompt preamble',
      };
  }
}
