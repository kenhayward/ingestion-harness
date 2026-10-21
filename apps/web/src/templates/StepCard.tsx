import type { ReactNode } from 'react';
import { Icon } from '../ui/Icon.js';
import { STEP_KIND_TONE, stepKind, stepSummary } from './editor-derive.js';

/**
 * A pipeline step as a card (UI handoff §5): the header (number, kind, id, summary) toggles the
 * body; move and remove sit beside it. The body keeps the "Step N" group name.
 */
export function StepCard({
  index,
  step,
  open,
  readOnly = false,
  onToggle,
  onMove,
  onRemove,
  modelName,
  inheritedModel,
  children,
}: {
  /** 0-based position. */
  index: number;
  step: Record<string, unknown>;
  open: boolean;
  /** Published version: the card opens, but nothing in it (or its tools) can change. */
  readOnly?: boolean;
  onToggle: () => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  /** A model choice's label from its id, for the summary. */
  modelName?: (id: string) => string;
  /** What a step naming no model runs, for the summary (default: "default model"). */
  inheritedModel?: string;
  children: ReactNode;
}) {
  const n = index + 1;
  const kind = stepKind(step);
  const id = typeof step.id === 'string' && step.id ? step.id : '(no id)';
  return (
    <div className={open ? 'step-card open' : 'step-card'}>
      <div className="step-head">
        <button type="button" className="step-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="step-num">{n}</span>{' '}
          <span className={`kind-tag ${STEP_KIND_TONE[kind]}`}>{kind}</span>{' '}
          <span className="mono step-id">{id}</span>{' '}
          {step.occurrences !== undefined && (
            <>
              <span
                className="kind-tag tone-neutral"
                title="Runs only on the occurrences whose heading matches"
              >
                filtered
              </span>{' '}
            </>
          )}
          <span className="step-summary muted">{stepSummary(step, modelName, inheritedModel)}</span>
        </button>
        <fieldset className="step-tools" disabled={readOnly}>
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
        </fieldset>
      </div>
      {open && (
        <fieldset className="step-body" aria-label={`Step ${n}`} disabled={readOnly}>
          {children}
        </fieldset>
      )}
    </div>
  );
}
