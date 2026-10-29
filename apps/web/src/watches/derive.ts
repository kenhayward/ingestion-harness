import type { WatchHealth, WatchView } from '@ih/shared';
import { relativeTime, type Tone } from '../jobs/derive.js';

/** How a watch's health reads on its row. */
export const HEALTH: Record<WatchHealth, { label: string; tone: Tone }> = {
  running: { label: 'Running', tone: 'ok' },
  draining: { label: 'Draining', tone: 'info' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  problem: { label: 'Problem', tone: 'danger' },
};

/** "3 waiting · 2 in progress". */
/** Who a watch runs as; one wording for a user the API cannot name. */
export const runAsName = (w: Pick<WatchView, 'runAs'>) => w.runAs.name ?? 'Nobody';

export const queueText = (w: Pick<WatchView, 'queue'>) =>
  `${w.queue.waiting} waiting · ${w.queue.inProgress} in progress`;

/** "5 delivered · 1 failed". */
export const figuresText = (f: { delivered: number; failed: number }) =>
  `${f.delivered} delivered · ${f.failed} failed`;

/** When a watch last picked a file up: relative, else "Never". */
export const pickupText = (iso: string | null, now: number) =>
  iso ? relativeTime(iso, now) : 'Never';

/** What a stopped watch needs to say about a folder or target change. */
export const STOP_TO_CHANGE = 'Stop the watch to change the target or the folder.';

/** "1 file", "4 files". */
export const filesText = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

/** What a successful test says. */
export const testedText = (files: number) => `${filesText(files)} found at the folder root.`;

/** The text Start carries: it also retries moves the sink refused. */
export const START_HINT =
  'Looks at the folder at once and tries stuck moves again. After clearing the folder, stop and start the watch to retry stuck moves.';
