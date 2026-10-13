import type { QueueSummary } from '@ih/shared';
import type { QueueStats } from '../repositories/types.js';

/**
 * The Test runs tab's queue line (handoff TR4). A new Workbench run waits behind every queued
 * document job; each running job is taken as one busy worker (at least one), and recent runs'
 * median duration gives a rough wait. No history: no estimate (null). Nothing queued: 0.
 */
export function queueSummary({ queued, running, medianSeconds }: QueueStats): QueueSummary {
  const etaSeconds =
    queued === 0
      ? 0
      : medianSeconds === null
        ? null
        : Math.ceil((queued * medianSeconds) / Math.max(1, running));
  return { ahead: queued, running, etaSeconds };
}
