import type { ReactNode } from 'react';
import { Icon } from '../ui/Icon.js';
import { stepSummary } from './editor-derive.js';

/**
 * A pipeline step as a card (UI handoff §5): the header (number, kind, id, summary) toggles the
 * body; move and remove sit beside it. The body keeps the "Step N" group name.
 */
export function StepCard({
  index,
  step,
  open,
  onToggle,
  onMove,
  onRemove,
  children,
}: {
  /** 0-based position. */
  index: number;
  step: Record<string, unknown>;
  open: boolean;
  onToggle: () => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const n = index + 1;
  const kind = step.type === 'check' ? 'CHECK' : 'EXTRACT';
  const id = typeof step.id === 'string' && step.id ? step.id : '(no id)';
  return (
    <div className={open ? 'step-card open' : 'step-card'}>
      <div className="step-head">
        <button type="button" className="step-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="step-num">{n}</span>{' '}
          <span className={`kind-tag ${kind === 'CHECK' ? 'tone-neutral' : 'tone-info'}`}>
            {kind}
          </span>{' '}
          <span className="mono step-id">{id}</span>{' '}
          <span className="step-summary muted">{stepSummary(step)}</span>
        </button>
        <div className="step-tools">
          <button
            type="button"
            className="icon bordered"
            aria-label={`Move step ${n} up`}
            onClick={() => onMove(-1)}
          >
            <Icon name="chevronUp" />
          </button>
          <button
            type="button"
            className="icon bordered"
            aria-label={`Move step ${n} down`}
            onClick={() => onMove(1)}
          >
            <Icon name="chevronDown" />
          </button>
          <button
            type="button"
            className="icon bordered danger"
            aria-label={`Remove step ${n}`}
            onClick={onRemove}
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>
      {open && (
        <fieldset className="step-body" aria-label={`Step ${n}`}>
          {children}
        </fieldset>
      )}
    </div>
  );
}
