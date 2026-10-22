/** A line of the Results list: a day's heading or a result. */
export type ResultLine<T> =
  { kind: 'day'; day: string; continued: boolean } | { kind: 'row'; row: T };

/**
 * Lay one page of the Results list out in `lines` lines: a heading before each day (counted as
 * a line), then its results, as many as fit, never ending on a heading. `continuedDay` is the
 * day the previous page ended in: a page starting inside it marks the heading continued.
 * `shown` is how many of `rows` made it; at least one when there is one.
 */
export function layOutPage<T>(
  rows: readonly T[],
  lines: number,
  dayOf: (row: T) => string,
  continuedDay: string | null,
): { lines: ResultLine<T>[]; shown: number } {
  const out: ResultLine<T>[] = [];
  let shown = 0;
  let lastDay: string | null = null;
  for (const row of rows) {
    const day = dayOf(row);
    const heading = day !== lastDay;
    if (shown > 0 && out.length + (heading ? 2 : 1) > lines) break;
    if (heading) out.push({ kind: 'day', day, continued: shown === 0 && day === continuedDay });
    out.push({ kind: 'row', row });
    lastDay = day;
    shown++;
  }
  return { lines: out, shown };
}
