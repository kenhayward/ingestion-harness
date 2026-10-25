import type { JobStatus } from '@ih/shared';
import { statusLabel, statusTone, type Tone } from '../jobs/derive.js';

/**
 * A status as a tone pill: always text + colour + dot, never colour alone. A job's status, or
 * any other status given as its label and tone (a conversion item's outcome, say).
 */
export function StatusPill(props: { status: JobStatus } | { label: string; tone: Tone }) {
  const [label, tone] =
    'status' in props
      ? [statusLabel(props.status), statusTone(props.status)]
      : [props.label, props.tone];
  return <span className={`pill tone-${tone}`}>{label}</span>;
}
