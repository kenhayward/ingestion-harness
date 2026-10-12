import type { JobSummary } from '@ih/shared';
import type { ReviewData } from '../api/client.js';
import type { EffectiveView } from './effective.js';

/**
 * Where this job sits in the review queue (awaiting_review, oldest first) and which one is next
 * (wrapping). A job outside the queue (read-only view, or polled away) has no position; next is
 * then the oldest waiting document.
 */
export function reviewQueue(
  jobs: readonly JobSummary[],
  currentId: string,
): { position: number | null; total: number; next: string | null } {
  const queue = jobs
    .filter((j) => j.status === 'awaiting_review')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const index = queue.findIndex((j) => j.id === currentId);
  const candidate = index === -1 ? queue[0] : queue[(index + 1) % queue.length];
  return {
    position: index === -1 ? null : index + 1,
    total: queue.length,
    next: candidate && candidate.id !== currentId ? candidate.id : null,
  };
}

/** A value the reviewer should look at: a field, or a table cell (1-based row). */
export type FlagTarget =
  { tab: 'fields'; field: string } | { tab: string; row: number; column: string };

export function targetKey(t: FlagTarget): string {
  return 'field' in t ? `field:${t.field}` : `${t.tab}:${t.row}:${t.column}`;
}

/** Flagged values in display order: fields first, then each table's cells row by row. */
export function flaggedTargets(
  view: EffectiveView,
  template: ReviewData['template'],
): FlagTarget[] {
  const targets: FlagTarget[] = [];
  for (const def of template.outputs.fields) {
    if (view.fields[def.id]?.flags.length) targets.push({ tab: 'fields', field: def.id });
  }
  for (const table of template.outputs.tables) {
    for (const row of view.tables[table.id] ?? []) {
      for (const column of table.columns) {
        if (row.cells[column.id]?.flags.length) {
          targets.push({ tab: table.id, row: row.number, column: column.id });
        }
      }
    }
  }
  return targets;
}
