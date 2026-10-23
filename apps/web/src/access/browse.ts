import type { SinkBrowseNode } from '@ih/shared';

/** One page of a sink's browse tree under `parentId` (null: the top). */
export type BrowsePage = (
  parentId: string | null,
  cursor: string | null,
) => Promise<{ nodes: SinkBrowseNode[]; nextCursor: string | null }>;

/**
 * What a destination field's browse tree is, as the browse dialog shows it:
 * - `flat`: selectable leaves (repositories), read whole;
 * - `grouped`: groups that can't be picked, each holding leaves (object storages under their
 *   projects), read whole;
 * - `tree`: anything deeper (a space, a folder), shown one level at a time from its first page.
 */
export type BrowseShape =
  | { kind: 'flat'; nodes: SinkBrowseNode[] }
  | { kind: 'grouped'; groups: { group: SinkBrowseNode; nodes: SinkBrowseNode[] }[] }
  | { kind: 'tree'; nodes: SinkBrowseNode[]; next: string | null };

/** A list is read whole, up to this many pages per level, so a filter sees all of it. */
export const LIST_PAGES = 50;

async function readAll(
  page: BrowsePage,
  parentId: string | null,
  first?: Awaited<ReturnType<BrowsePage>>,
) {
  let r = first ?? (await page(parentId, null));
  const nodes = [...r.nodes];
  for (let pages = 1; r.nextCursor && pages < LIST_PAGES; pages++) {
    r = await page(parentId, r.nextCursor);
    nodes.push(...r.nodes);
  }
  return nodes;
}

/** Reads a field's tree far enough to know its shape (and, for a list, all of it). */
export async function readShape(page: BrowsePage): Promise<BrowseShape> {
  const first = await page(null, null);
  if (!first.nodes.some((n) => n.hasChildren)) {
    return { kind: 'flat', nodes: await readAll(page, null, first) };
  }
  const tree: BrowseShape = { kind: 'tree', nodes: first.nodes, next: first.nextCursor };
  if (!first.nodes.every((n) => n.hasChildren && !n.selectable)) return tree;
  const roots = await readAll(page, null, first);
  const groups = await Promise.all(
    roots.map(async (group) => ({ group, nodes: await readAll(page, group.id) })),
  );
  if (groups.some((g) => g.nodes.some((n) => n.hasChildren))) return tree;
  return { kind: 'grouped', groups };
}

/** A grouped leaf's label for display: its own, with its group's in brackets. */
export const groupedLabel = (group: SinkBrowseNode, node: SinkBrowseNode) =>
  `${node.label} (${group.label})`;

/** The display label of the node `id` in a list (undefined: not in it, or the shape is a tree). */
export function labelIn(shape: BrowseShape, id: string): string | undefined {
  if (shape.kind === 'flat') return shape.nodes.find((n) => n.id === id)?.label;
  if (shape.kind === 'grouped') {
    for (const g of shape.groups) {
      const hit = g.nodes.find((n) => n.id === id);
      if (hit) return groupedLabel(g.group, hit);
    }
  }
  return undefined;
}
