import type { JobStatus } from '@ih/shared';
import { statusLabel, statusTone } from '../jobs/derive.js';

/** Job status as a tone pill: always text + colour + dot, never colour alone. */
export function StatusPill({ status }: { status: JobStatus }) {
  return <span className={`pill tone-${statusTone(status)}`}>{statusLabel(status)}</span>;
}
