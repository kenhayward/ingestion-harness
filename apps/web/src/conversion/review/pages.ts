import type { Block, DecomposedDocument, Flag, Section } from '@ih/bridge-contract';

/** A section or block of the decomposed document, with the element it sits in. */
type Element =
  | { kind: 'section'; section: Section; parent: string | null }
  | { kind: 'block'; block: Block; parent: string | null };

/** The blocks a block holds: a list's items' blocks, a table's cells' blocks. */
export function innerBlocks(block: Block): Block[] {
  if (block.kind === 'list') return block.items.flatMap((i) => i.blocks);
  if (block.kind === 'table') return block.rows.flatMap((r) => r.cells.flatMap((c) => c.blocks));
  return [];
}

/** Every section and block of the document by id, however deep. */
function indexOf(document: DecomposedDocument): Map<string, Element> {
  const index = new Map<string, Element>();
  const addBlock = (block: Block, parent: string | null) => {
    index.set(block.id, { kind: 'block', block, parent });
    for (const inner of innerBlocks(block)) addBlock(inner, block.id);
  };
  const addSection = (section: Section, parent: string | null) => {
    index.set(section.id, { kind: 'section', section, parent });
    for (const block of section.blocks) addBlock(block, section.id);
    for (const sub of section.sections) addSection(sub, section.id);
  };
  for (const block of document.blocks) addBlock(block, null);
  for (const section of document.sections) addSection(section, null);
  return index;
}

/**
 * Where each element of a held document is: its pages from the manifest's `pageMap`. A section
 * with no pages of its own takes the first page of its first block (or subsection) that has one;
 * a block with none takes the pages of the element it sits in.
 */
export function documentPages(document: DecomposedDocument, pageMap: Record<string, number[]>) {
  const index = indexOf(document);
  const own = (id: string) => (pageMap[id]?.length ? pageMap[id] : null);
  const firstOfSection = (section: Section): number | null => {
    for (const block of section.blocks) {
      const pages = own(block.id);
      if (pages) return pages[0]!;
    }
    for (const sub of section.sections) {
      const page = own(sub.id)?.[0] ?? firstOfSection(sub);
      if (page) return page;
    }
    return null;
  };
  const pagesOf = (id: string | null): readonly number[] => {
    if (id === null) return [];
    const pages = own(id);
    if (pages) return pages;
    const element = index.get(id);
    if (!element) return [];
    if (element.kind === 'section') {
      const first = firstOfSection(element.section);
      if (first) return [first];
    }
    return pagesOf(element.parent);
  };
  return {
    /** The element's pages, in order (empty when nothing places it). */
    pagesOf,
    /** The page a choice of the element shows, if any. */
    firstPage: (id: string | null): number | null => pagesOf(id)[0] ?? null,
    /** Whether a flag names an element of this document (else it is the document's own). */
    has: (id: string | null) => id !== null && index.has(id),
  };
}

export type DocumentPages = ReturnType<typeof documentPages>;

/** Flags by the element they are on; those on no element of the document under `null`. */
export function flagsByElement(flags: readonly Flag[], pages: DocumentPages) {
  const byAt = new Map<string | null, Flag[]>();
  for (const flag of flags) {
    const at = pages.has(flag.at) ? flag.at : null;
    byAt.set(at, [...(byAt.get(at) ?? []), flag]);
  }
  return byAt;
}

/** The flags counted by code, most first (ties by code). */
export function flagCounts(flags: readonly Flag[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const flag of flags) counts.set(flag.code, (counts.get(flag.code) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
