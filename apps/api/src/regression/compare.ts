/**
 * Compare a run's document against a reference's expected values.
 *
 * Values are compared loosely the way a reviewer would: case and whitespace are ignored,
 * numbers equal their string forms ("120.10" = 120.1), list order is ignored, and table rows
 * are matched as a multiset (row order does not matter).
 */

export interface Expected {
  fields: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
}

/** document.json-like: fields carry {value, ...}; tables are row lists. */
export interface RunDocument {
  fields: Record<string, { value?: unknown } | undefined>;
  tables: Record<string, Record<string, unknown>[] | undefined>;
}

export interface FieldComparison {
  id: string;
  expected: unknown;
  actual: unknown;
  match: boolean;
}

export interface TableComparison {
  id: string;
  expected: number;
  actual: number;
  matched: number;
  missing: Record<string, unknown>[];
  extra: Record<string, unknown>[];
}

export interface Comparison {
  /** Matched fields + matched rows over expected fields + expected rows (1 = identical). */
  score: number;
  fields: FieldComparison[];
  tables: TableComparison[];
}

export function expectedFromDocument(doc: RunDocument): Expected {
  return {
    fields: Object.fromEntries(Object.entries(doc.fields).map(([id, f]) => [id, f?.value ?? null])),
    tables: Object.fromEntries(Object.entries(doc.tables).map(([id, rows]) => [id, rows ?? []])),
  };
}

function normalise(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const text = value.trim().replace(/\s+/g, ' ');
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    return text.toLowerCase();
  }
  if (Array.isArray(value)) return value.map((v) => JSON.stringify(normalise(v))).sort();
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalise(v)]),
    );
  }
  return value;
}

const key = (value: unknown) => JSON.stringify(normalise(value));

export function compareToReference(expected: Expected, actual: RunDocument): Comparison {
  const fields = Object.entries(expected.fields).map(([id, value]) => {
    const got = actual.fields[id]?.value ?? null;
    return { id, expected: value, actual: got, match: key(value) === key(got) };
  });

  const tables = Object.entries(expected.tables).map(([id, rows]) => {
    const remaining = new Map<string, Record<string, unknown>[]>();
    for (const row of actual.tables[id] ?? []) {
      const k = key(row);
      remaining.set(k, [...(remaining.get(k) ?? []), row]);
    }
    const missing: Record<string, unknown>[] = [];
    let matched = 0;
    for (const row of rows) {
      const bucket = remaining.get(key(row));
      if (bucket?.length) {
        bucket.pop();
        matched += 1;
      } else {
        missing.push(row);
      }
    }
    return {
      id,
      expected: rows.length,
      actual: actual.tables[id]?.length ?? 0,
      matched,
      missing,
      extra: [...remaining.values()].flat(),
    };
  });

  const total = fields.length + tables.reduce((n, t) => n + t.expected, 0);
  const hits = fields.filter((f) => f.match).length + tables.reduce((n, t) => n + t.matched, 0);
  return { score: total === 0 ? 1 : hits / total, fields, tables };
}
