import { relativeTime } from '../jobs/derive.js';
import { Icon } from '../ui/Icon.js';

/** The failed sign-ins a successful sign-in cleared (ADR 0013, D9), shown once until dismissed. */
export interface FailedSignIns {
  count: number;
  lastFailedAt: string | null;
}

export function failedSignInsText({ count, lastFailedAt }: FailedSignIns, now = Date.now()) {
  const what = `${count} failed sign-in${count === 1 ? '' : 's'} since your last visit`;
  const when = lastFailedAt
    ? `, the last one ${relativeTime(lastFailedAt, now).toLowerCase()}`
    : '';
  return `${what}${when}. If that wasn't you, tell an admin.`;
}

export function FailedSignInsNotice({
  failed,
  onDismiss,
}: {
  failed: FailedSignIns;
  onDismiss: () => void;
}) {
  return (
    <div role="status" aria-label="Failed sign-ins" className="callout tone-warn failed-sign-ins">
      <Icon name="alert" size={18} />
      <span>{failedSignInsText(failed)}</span>
      <button type="button" className="icon" aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="check" size={16} />
      </button>
    </div>
  );
}
