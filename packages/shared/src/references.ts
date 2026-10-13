/**
 * Workbench references across versions (phase 5b): a reference remembers the outputs definition
 * it was verified against. It stays valid for a later version while every value it covers keeps
 * its shape; names and descriptions don't change values, so they don't count.
 */

type Shape = Map<string, string>;

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(record) : []);

/** A value's shape: type (default text) and its enum values, order ignored. */
const valueShape = (v: Record<string, unknown>) =>
  JSON.stringify([
    typeof v.type === 'string' ? v.type : 'text',
    Array.isArray(v.enum) ? [...(v.enum as unknown[])].map(String).sort() : null,
  ]);

/** `field:<id>`, `table:<id>` and `table:<id>.<column>` keys with their shapes. */
function shapes(outputs: unknown): Shape {
  const out: Shape = new Map();
  const o = record(outputs);
  for (const f of list(o.fields)) {
    if (typeof f.id === 'string') out.set(`field:${f.id}`, valueShape(f));
  }
  for (const t of list(o.tables)) {
    if (typeof t.id !== 'string') continue;
    out.set(`table:${t.id}`, '');
    for (const c of list(t.columns)) {
      if (typeof c.id === 'string') out.set(`table:${t.id}.${c.id}`, valueShape(c));
    }
  }
  return out;
}

/**
 * Output keys whose values a reference verified against `verified` can no longer vouch for under
 * `current`: added, removed or reshaped fields, tables and columns. A removed table reports the
 * table only. Null `verified` (an unpinned, legacy reference) is always trusted: [].
 */
export function outputChanges(verified: unknown, current: unknown): string[] {
  if (verified === null || verified === undefined) return [];
  const before = shapes(verified);
  const after = shapes(current);
  const changed = new Set<string>();
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) === after.get(key)) continue;
    const table = key.startsWith('table:') && key.includes('.') ? key.slice(0, key.indexOf('.')) : null;
    // a column of a table that is gone (or new) as a whole is reported as the table
    if (table && before.has(table) !== after.has(table)) continue;
    changed.add(key);
  }
  return [...changed].sort();
}
