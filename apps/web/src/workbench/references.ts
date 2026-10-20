import { correctionOutput, type JobStatus, type ReferenceRow } from '@ih/shared';
import { progressText } from './runs.js';

/** Pure helpers of the References tab (handoff §7). */

const outputName = (key: string) => key.replace(/^(field|table):/, '');

export const isActive = (status: JobStatus) => status === 'queued' || status === 'running';

/** A reference that Evaluate can use: present and verified against the current outputs. */
export const verified = (row: ReferenceRow) =>
  row.reference !== null && row.reference.outdated.length === 0;

export interface Tracker {
  ran: boolean;
  reviewed: boolean;
  saved: boolean;
}

/** Run → Reviewed → Saved. A saved (even outdated) reference was run and reviewed. */
export function tracker(row: ReferenceRow): Tracker {
  const status = row.run?.status ?? null;
  const reviewed = row.reference !== null || status === 'succeeded';
  return { ran: reviewed || status === 'awaiting_review', reviewed, saved: verified(row) };
}

export const trackerLabel = (t: Tracker) =>
  [
    `Run: ${t.ran ? 'done' : 'not yet'}`,
    `Reviewed: ${t.reviewed ? 'done' : 'not yet'}`,
    `Saved: ${t.saved ? 'done' : 'not yet'}`,
  ].join(' · ');

export function rowStatus(row: ReferenceRow): string {
  if (row.reference) {
    return row.reference.outdated.length === 0
      ? 'Verified'
      : `Re-verify: ${row.reference.outdated.map(outputName).join(', ')} changed`;
  }
  const status = row.run?.status ?? null;
  if (status === null) return 'Not run';
  if (status === 'queued') return 'Waiting for a worker';
  if (status === 'running') return 'Running';
  if (status === 'awaiting_review') return 'Awaiting review';
  if (status === 'succeeded') return 'Reviewed — save it as the reference';
  return 'Run needs attention';
}

/**
 * Where a running reference run is, from its latest progress event: reading or OCR'ing the
 * sample, the sections found, or the step being extracted; null when the run is not running.
 */
export function rowProgress(row: ReferenceRow): string | null {
  const run = row.run;
  if (run?.status !== 'running') return null;
  const p = run.progress ?? null;
  if (p === null) return 'Starting…';
  if (p.kind === 'prepare') {
    return p.stage === 'ocr'
      ? `OCR page ${p.page} of ${p.of}`
      : `Reading ${p.of} ${p.of === 1 ? 'page' : 'pages'}`;
  }
  if (p.kind === 'segmented') return 'Found the sections';
  return progressText(p);
}

/**
 * The reference runs still to verify while any of them is queued or running: how many run, wait
 * and finished (awaiting review or needing attention) out of the unverified samples with a run;
 * null when none is active.
 */
export function runsSummary(
  rows: readonly ReferenceRow[],
): { running: number; queued: number; finished: number; total: number } | null {
  const runs = rows.flatMap((r) => (!verified(r) && r.run ? [r.run.status] : []));
  const running = runs.filter((s) => s === 'running').length;
  const queued = runs.filter((s) => s === 'queued').length;
  if (running + queued === 0) return null;
  return { running, queued, finished: runs.length - running - queued, total: runs.length };
}

/**
 * The tab header's status while reference runs are going: which documents of the round are
 * running and, for a single one, where it is ("Running document 2 of 5 · Step 2 of 6 · lines");
 * null when none is queued or running (the overview's status stands).
 */
export function runsTitle(rows: readonly ReferenceRow[]): string | null {
  const summary = runsSummary(rows);
  if (!summary) return null;
  const { running, finished, total } = summary;
  if (running === 0) return `Waiting for a worker · ${finished} of ${total} finished`;
  if (running === 1) {
    const row = rows.find((r) => !verified(r) && r.run?.status === 'running')!;
    return `Running document ${finished + 1} of ${total} · ${rowProgress(row)}`;
  }
  const numbers = Array.from({ length: running }, (_, i) => String(finished + 1 + i));
  const list = `${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
  return `Running documents ${list} of ${total} · ${finished} finished`;
}

/** "11 Oct 16:55" in the viewer's time zone. */
export const shortDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** "Re-verified in v4 · 11 Oct 16:55 · was v3", "Carried from v3 · …", "Verified in v4 · …". */
export function rowLine(row: ReferenceRow): string {
  const r = row.reference;
  if (!r) return 'Not verified yet';
  const at = shortDateTime(r.createdAt);
  if (r.carriedFrom !== null) return `Carried from v${r.carriedFrom} · ${at}`;
  const v = r.version ?? null;
  if (v === null) return `Verified · ${at}`;
  if (r.reverified) return `Re-verified in v${v} · ${at} · was v${r.reverified.from}`;
  return `Verified in v${v} · ${at}`;
}

/** Outputs the reviewer corrected (entered-by-hand values show in the strip and the panel). */
export function correctionSummary(row: ReferenceRow): string {
  const r = row.reference;
  if (!r) return '';
  if (r.corrections === null) return 'Corrections unknown';
  const outputs = [
    ...new Set(
      r.corrections.filter((c) => c.kind === 'corrected').map((c) => correctionOutput(c.key)),
    ),
  ];
  return outputs.length ? `Corrected: ${outputs.join(', ')}` : 'No corrections';
}

export const reviewHref = (row: ReferenceRow): string | null => {
  if (row.reference?.sourceJobId) return `#/review/${row.reference.sourceJobId}`;
  const run = row.run;
  return run && (run.status === 'awaiting_review' || run.status === 'succeeded')
    ? `#/review/${run.jobId}`
    : null;
};

/** Samples a run button would queue: no verified reference and no active run. */
export const unverifiedCount = (rows: readonly ReferenceRow[]) =>
  rows.filter((r) => !verified(r) && !(r.run && isActive(r.run.status))).length;

export const REFERENCE_FILTERS = ['all', 'corrected', 'needs'] as const;
export type ReferenceFilter = (typeof REFERENCE_FILTERS)[number];

export function matchesFilter(row: ReferenceRow, filter: ReferenceFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'corrected') {
    return verified(row) && (row.reference!.corrections ?? []).some((c) => c.kind === 'corrected');
  }
  return !verified(row);
}

/** The ready banner: every dev and holdout sample has a verified reference (at least one dev). */
export function readyBanner(
  dev: readonly ReferenceRow[],
  holdout: readonly ReferenceRow[],
  version: number | null,
  hasDraft = true,
): { ready: boolean; text: string } {
  if (dev.length === 0 || ![...dev, ...holdout].every(verified)) return { ready: false, text: '' };
  const again = [...dev, ...holdout].filter((r) => r.reference!.reverified !== null);
  const changed = [
    ...new Set(again.flatMap((r) => r.reference!.reverified!.changed.map(outputName))),
  ];
  const why =
    again.length === 0
      ? ''
      : ` ${again.length} ${again.length === 1 ? 'was' : 'were'} re-verified this version${
          changed.length ? ` because these outputs changed: ${changed.join(', ')}` : ''
        }.`;
  return {
    ready: true,
    text: `${dev.length} dev and ${holdout.length} holdout references match the ${hasDraft ? 'draft' : 'published'} v${version ?? '?'} outputs.${why}`,
  };
}
