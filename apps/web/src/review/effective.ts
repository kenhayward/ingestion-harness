import type { ReviewEdit } from '@ih/shared';
import type { ReviewData } from '../api/client.js';

export interface FieldView {
  value: unknown;
  evidence: string | null;
  page: number | null;
  /** Latest edit of this field, if any. */
  edit: ReviewEdit | null;
  flags: string[];
}

export interface CellView {
  value: unknown;
  edit: ReviewEdit | null;
  /** Reasons to look at this cell: normalisation issues, unmatched check values. */
  flags: string[];
}

export interface RowView {
  /** 1-based, as used by edits and issues. */
  number: number;
  cells: Record<string, CellView>;
  flagged: boolean;
}

export interface EffectiveView {
  fields: Record<string, FieldView>;
  tables: Record<string, RowView[]>;
  flaggedCount: number;
}

/**
 * What the reviewer sees: draft values with the latest edit per field/cell applied, and flags
 * for anything still needing attention. Edited values drop their flags (the reviewer has acted);
 * the worker re-normalises edits and re-runs checks when publishing.
 */
export function effectiveView({ template, document, edits }: ReviewData): EffectiveView {
  const fieldEdits = new Map<string, ReviewEdit>();
  const cellEdits = new Map<string, ReviewEdit>();
  for (const e of edits) {
    if (e.field) fieldEdits.set(e.field, e);
    else cellEdits.set(`${e.table}|${e.row}|${e.column}`, e);
  }
  const issues = new Map<string, string[]>();
  for (const i of document.issues) {
    const key = i.row === null ? `field|${i.target}` : `${i.target}|${i.row}|${i.column}`;
    issues.set(key, [...(issues.get(key) ?? []), i.message]);
  }

  // Check steps whose values come from a table column flag that column's unmatched values.
  const checkFlags = new Map<string, Map<string, string>>(); // "table|column" -> value -> flag
  for (const step of template.pipeline) {
    if (step.type !== 'check') continue;
    const [table, column] = step.values.split('.');
    if (!column) continue;
    const unmatched = (document.checks[step.id]?.rows ?? []).filter(
      (r) => r.status === 'unmatched',
    );
    const flags = checkFlags.get(`${table}|${column}`) ?? new Map<string, string>();
    for (const r of unmatched)
      flags.set(normalise(r.value), `${step.id}: ${r.message ?? 'unmatched'}`);
    checkFlags.set(`${table}|${column}`, flags);
  }

  let flaggedCount = 0;
  const fields: Record<string, FieldView> = {};
  for (const def of template.outputs.fields) {
    const draft = document.fields[def.id] ?? { value: null, evidence: null, page: null };
    const edit = fieldEdits.get(def.id) ?? null;
    const flags = edit ? [] : (issues.get(`field|${def.id}`) ?? []);
    flaggedCount += flags.length ? 1 : 0;
    fields[def.id] = { ...draft, value: edit ? edit.newValue : draft.value, edit, flags };
  }

  const tables: Record<string, RowView[]> = {};
  for (const def of template.outputs.tables) {
    tables[def.id] = (document.tables[def.id] ?? []).map((row, index) => {
      const number = index + 1;
      const cells: Record<string, CellView> = {};
      for (const column of def.columns) {
        const edit = cellEdits.get(`${def.id}|${number}|${column.id}`) ?? null;
        const value = edit ? edit.newValue : (row[column.id] ?? null);
        const checkFlag =
          typeof value === 'string'
            ? checkFlags.get(`${def.id}|${column.id}`)?.get(normalise(value))
            : undefined;
        const flags = edit
          ? []
          : [
              ...(issues.get(`${def.id}|${number}|${column.id}`) ?? []),
              ...(checkFlag ? [checkFlag] : []),
            ];
        flaggedCount += flags.length ? 1 : 0;
        cells[column.id] = { value, edit, flags };
      }
      return { number, cells, flagged: Object.values(cells).some((c) => c.flags.length > 0) };
    });
  }
  return { fields, tables, flaggedCount };
}

/**
 * The comparison form of a check value, the worker's `checks.norm` (held in step by
 * `packages/shared/test/fixtures/check-norm.json`): NFKC, no zero-width characters, every dash
 * variant as `-`, no whitespace, upper case.
 */
export function normalise(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\u200b|\u200c|\u200d|\u2060|\ufeff|\u00ad/g, '')
    .replace(/[\u2010-\u2015\u2212\ufe63\uff0d]/g, '-')
    .replace(/\s+/g, '')
    .toUpperCase();
}

/** Display form of a value: lists comma-separated, null/empty as an em dash. */
export function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  return String(value);
}
