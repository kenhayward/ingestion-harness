/**
 * Compare a run's document against a reference's expected values.
 *
 * Values are compared loosely the way a reviewer would: case and whitespace are ignored,
 * numbers equal their string forms ("120.10" = 120.1, "137·8" = 137.8), list order is ignored.
 * Table rows are aligned to their best-matching counterpart (row order does not matter) and
 * scored per cell, so one noisy cell costs one cell rather than the whole row; extra rows count
 * against the score (it measures agreement with the reference, in both directions).
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
  /** Rows identical to their expected counterpart. */
  matched: number;
  /** Expected rows with no counterpart sharing any cell. */
  missing: Record<string, unknown>[];
  /** Actual rows not aligned to any expected row. */
  extra: Record<string, unknown>[];
  /** Aligned rows that differ, with the differing columns. */
  changed: {
    expected: Record<string, unknown>;
    actual: Record<string, unknown>;
    columns: string[];
  }[];
  /** Equal cells / all cells considered (aligned rows, missing rows, extra rows). */
  cells: number;
  cellsTotal: number;
}

export interface Comparison {
  /** (matched fields + equal cells) / (fields + all cells considered); 1 = identical. */
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
    const numeric = text.replace('·', '.');
    if (/^-?\d+(\.\d+)?$/.test(numeric)) return Number(numeric);
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
    const candidates = actual.tables[id] ?? [];
    const used = new Set<number>();
    const result: TableComparison = {
      id,
      expected: rows.length,
      actual: candidates.length,
      matched: 0,
      missing: [],
      extra: [],
      changed: [],
      cells: 0,
      cellsTotal: 0,
    };
    for (const row of rows) {
      let best = -1;
      let bestEqual = 0;
      candidates.forEach((candidate, i) => {
        if (used.has(i)) return;
        const equal = columnsOf(row, candidate).filter(
          (c) => key(row[c]) === key(candidate[c]),
        ).length;
        if (equal > bestEqual) [best, bestEqual] = [i, equal];
      });
      if (best < 0) {
        result.missing.push(row);
        result.cellsTotal += Object.keys(row).length;
        continue;
      }
      used.add(best);
      const counterpart = candidates[best]!;
      const columns = columnsOf(row, counterpart);
      const differing = columns.filter((c) => key(row[c]) !== key(counterpart[c]));
      result.cells += columns.length - differing.length;
      result.cellsTotal += columns.length;
      if (differing.length)
        result.changed.push({ expected: row, actual: counterpart, columns: differing });
      else result.matched += 1;
    }
    candidates.forEach((candidate, i) => {
      if (used.has(i)) return;
      result.extra.push(candidate);
      result.cellsTotal += Object.keys(candidate).length;
    });
    return result;
  });

  const total = fields.length + tables.reduce((n, t) => n + t.cellsTotal, 0);
  const hits = fields.filter((f) => f.match).length + tables.reduce((n, t) => n + t.cells, 0);
  return { score: total === 0 ? 1 : hits / total, fields, tables };
}

function columnsOf(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}
