import { PAGE_SIZES, type ProjectListItem } from '@ih/shared';

/** Page buttons: first, last, the current one and its neighbours, gaps as '…'. */
export function pagerPages(current: number, last: number): (number | '…')[] {
  if (last <= 5) return Array.from({ length: last }, (_, i) => i + 1);
  const keep = new Set(
    [1, last, current - 1, current, current + 1].filter((p) => p >= 1 && p <= last),
  );
  // Near an end, show three pages so the row does not jump in width.
  if (current <= 2) [2, 3].forEach((p) => keep.add(p));
  if (current >= last - 1) [last - 2, last - 1].forEach((p) => keep.add(p));
  const pages = [...keep].sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  pages.forEach((p, i) => {
    if (i > 0 && p - pages[i - 1]! > 1) out.push('…');
    out.push(p);
  });
  return out;
}

const PHASE: Record<ProjectListItem['phase'], string> = {
  prepare: 'Prepare',
  draft: 'Draft',
  verify: 'Verify',
  published: 'Published',
};

export function phaseLine(item: ProjectListItem): string {
  return item.phase === 'published'
    ? 'Published · no open draft'
    : `${PHASE[item.phase]} · ${item.done} of 10 done`;
}

export function nextHref(item: ProjectListItem): string {
  const stage = item.next?.stage ?? null;
  const tab = stage === null ? 'template' : stage === 'publish' ? 'evaluate' : stage;
  return `#/workbench/${item.id}/${tab}`;
}

export const PAGE_SIZE_KEY = 'ih.wbPageSize';
export function loadPageSize(): 25 | 50 | 100 {
  try {
    const n = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return (PAGE_SIZES as readonly number[]).includes(n) ? (n as 25 | 50 | 100) : 25;
  } catch {
    return 25;
  }
}
export function savePageSize(n: 25 | 50 | 100): void {
  try {
    localStorage.setItem(PAGE_SIZE_KEY, String(n));
  } catch {
    // Private mode or blocked storage: the choice lasts for this visit only.
  }
}

export const RECENT_KEY = 'ih.wbRecent';
export function recentProjects(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === 'string').slice(0, 10)
      : [];
  } catch {
    return [];
  }
}
export function rememberProject(id: string): void {
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([id, ...recentProjects().filter((x) => x !== id)].slice(0, 10)),
    );
  } catch {
    // Recents are a convenience; nothing to do when storage is unavailable.
  }
}

export const formatCount = (n: number): string => n.toLocaleString('en-US');
