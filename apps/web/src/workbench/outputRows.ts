import { stableJson } from '@ih/shared';

export type VsLive = 'added' | 'changed' | 'removed' | null;

export interface OutputRow {
  kind: 'field' | 'table' | 'column';
  id: string;
  /** The table a column belongs to. */
  table: string | null;
  name: string;
  type: string;
  values: string;
  description: string;
  vsLive: VsLive;
}

export interface OutputSummary {
  fields: number;
  tables: number;
  columns: number;
  added: number;
  changed: number;
  removed: number;
}

type Def = Record<string, unknown>;
const obj = (v: unknown): Def =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Def) : {};
const list = (v: unknown): Def[] =>
  Array.isArray(v) ? v.map(obj).filter((x) => typeof x.id === 'string') : [];
const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : '—');
const typeOf = (v: Def) => (typeof v.type === 'string' ? v.type : 'text');
const outputsOf = (def: Def) => {
  const o = obj(def.outputs);
  return { fields: list(o.fields), tables: list(o.tables) };
};
const sameValue = (a: Def, b: Def) =>
  stableJson({ name: a.name, type: typeOf(a), description: a.description, enum: a.enum }) ===
  stableJson({ name: b.name, type: typeOf(b), description: b.description, enum: b.enum });
const sameTable = (a: Def, b: Def) =>
  stableJson({ name: a.name, description: a.description }) ===
  stableJson({ name: b.name, description: b.description });

function compare(draft: Def[], live: Def[] | null, same: (a: Def, b: Def) => boolean) {
  if (live === null) return draft.map((item) => ({ item, vsLive: null as VsLive }));
  const byId = new Map(live.map((x) => [x.id, x]));
  const draftIds = new Set(draft.map((x) => x.id));
  return [
    ...draft.map((item) => {
      const old = byId.get(item.id);
      const vsLive: VsLive = old === undefined ? 'added' : same(old, item) ? null : 'changed';
      return { item, vsLive };
    }),
    ...live
      .filter((x) => !draftIds.has(x.id))
      .map((item) => ({ item, vsLive: 'removed' as VsLive })),
  ];
}

function valueRow(
  v: Def,
  kind: 'field' | 'column',
  table: string | null,
  vsLive: VsLive,
): OutputRow {
  return {
    kind,
    id: String(v.id),
    table,
    name: text(v.name),
    type: typeOf(v),
    values: Array.isArray(v.enum) ? v.enum.join(', ') : '—',
    description: text(v.description),
    vsLive,
  };
}

/** The draft's outputs beside the live version's (null: nothing published yet). */
export function outputRows(draft: Def, live: Def | null): OutputRow[] {
  const d = outputsOf(draft);
  const l = live === null ? null : outputsOf(live);
  const fields = compare(d.fields, l?.fields ?? null, sameValue).map(({ item, vsLive }) =>
    valueRow(item, 'field', null, vsLive),
  );
  const tables = compare(d.tables, l?.tables ?? null, sameTable).flatMap(({ item, vsLive }) => {
    const id = String(item.id);
    const whole = vsLive === 'added' || vsLive === 'removed';
    const liveColumns =
      whole || l === null ? null : list(l.tables.find((t) => t.id === id)?.columns);
    const columns = compare(list(item.columns), liveColumns, sameValue).map((c) =>
      valueRow(c.item, 'column', id, whole ? vsLive : c.vsLive),
    );
    const row: OutputRow = {
      kind: 'table',
      id,
      table: null,
      name: text(item.name),
      type: 'table',
      values: `${list(item.columns).length} columns`,
      description: text(item.description),
      vsLive,
    };
    return [row, ...columns];
  });
  return [...fields, ...tables];
}

export function outputSummary(rows: OutputRow[]): OutputSummary {
  const tableTag = new Map(rows.filter((r) => r.kind === 'table').map((r) => [r.id, r.vsLive]));
  const present = rows.filter((r) => r.vsLive !== 'removed');
  const counted = rows.filter((r) => {
    if (r.kind !== 'column') return true;
    const parent = tableTag.get(r.table ?? '');
    return parent !== 'added' && parent !== 'removed';
  });
  const count = (xs: OutputRow[], f: (r: OutputRow) => boolean) => xs.filter(f).length;
  return {
    fields: count(present, (r) => r.kind === 'field'),
    tables: count(present, (r) => r.kind === 'table'),
    columns: count(present, (r) => r.kind === 'column'),
    added: count(counted, (r) => r.vsLive === 'added'),
    changed: count(counted, (r) => r.vsLive === 'changed'),
    removed: count(counted, (r) => r.vsLive === 'removed'),
  };
}

/** "Changed since vN": tagged rows, plus the table of a tagged column. */
export function changedRows(rows: OutputRow[]): OutputRow[] {
  return rows.filter(
    (r) =>
      r.vsLive !== null ||
      (r.kind === 'table' && rows.some((c) => c.table === r.id && c.vsLive !== null)),
  );
}
