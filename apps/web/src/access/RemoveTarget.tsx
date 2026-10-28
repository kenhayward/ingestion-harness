import { useState } from 'react';
import { blocksRemoval, type PublishTargetView } from '@ih/shared';
import { Icon } from '../ui/Icon.js';

const REMOVE_BLOCKED = 'An S3 key consumer or a pending withdrawal names it';

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** `a`, `a and b`, `a, b and c`. */
function list(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What removing a target in use does to what names it (nothing said for one nothing names). */
function consequences(u: PublishTargetView['usage']): string[] {
  const out: string[] = [];
  const types = u.documentTypes;
  if (types.length > 0) {
    out.push(
      types.length === 1
        ? `${types[0]} delivers to it: its new documents go to review until you publish a version without it.`
        : `${list(types)} deliver to it: their new documents go to review until you publish versions without it.`,
    );
  }
  if (u.deliveredOutputs > 0) {
    out.push(
      `Its ${count(u.deliveredOutputs, 'delivered output')} stay listed; withdrawing them deletes nothing through it.`,
    );
  }
  return out;
}

/**
 * A target's Remove button and its confirm. A target recipes or outputs name can be removed (its
 * destination may be gone); the confirm says what happens to them. A key consumer or a pending
 * withdrawal keeps it.
 */
export function RemoveTarget({
  target: t,
  busy,
  onRemove,
}: {
  target: PublishTargetView;
  busy: boolean;
  onRemove: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const blocked = blocksRemoval(t.usage);
  if (!confirm) {
    return (
      <>
        <button
          type="button"
          className="danger"
          disabled={blocked}
          title={blocked ? REMOVE_BLOCKED : undefined}
          onClick={() => setConfirm(true)}
        >
          <Icon name="trash" />
          Remove
        </button>
        {blocked && <small className="muted">{REMOVE_BLOCKED}</small>}
      </>
    );
  }
  return (
    <div className="confirm-text">
      {consequences(t.usage).map((line) => (
        <p key={line} className="muted">
          {line}
        </p>
      ))}
      <p>
        Remove {t.label}?{' '}
        <button
          type="button"
          className="danger"
          aria-label={`Confirm remove ${t.label}`}
          disabled={busy}
          onClick={onRemove}
        >
          Remove
        </button>{' '}
        <button type="button" onClick={() => setConfirm(false)}>
          Cancel
        </button>
      </p>
    </div>
  );
}
