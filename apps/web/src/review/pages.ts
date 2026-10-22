/**
 * A table column holding the page a row was found on: its id or name, read without case,
 * spaces or punctuation, is "page", "pages", "page no", "page number" or "page #", optionally
 * after "source" or "pdf" ("source_page", "pdf_page").
 */
export function isPageColumn(column: { id: string; name?: string | undefined }): boolean {
  const names = [column.id, column.name ?? ''].map((n) =>
    n
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/#/g, ' no ')
      .replace(/[^a-z]+/g, ' ')
      .trim(),
  );
  return names.some((n) => /^(?:(?:source|pdf) )?pages?(?: (?:no|num|number))?$/.test(n));
}

/**
 * The page a page column's value names (its first whole number: 14, "p. 14", "14-15", or the
 * first of a list), or null when there is none or the document has no such page.
 */
export function pageOf(value: unknown, pageCount: number): number | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== 'number' && typeof first !== 'string') return null;
  if (typeof first === 'number' && !Number.isInteger(first)) return null;
  const match = /\d+/.exec(String(first));
  const page = match ? Number(match[0]) : NaN;
  return page >= 1 && page <= pageCount ? page : null;
}
