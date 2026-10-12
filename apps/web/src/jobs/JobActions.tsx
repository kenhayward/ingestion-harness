import { useEffect, useId, useRef, useState } from 'react';
import { DELETABLE_STATUSES, type JobStatus, type JobSummary, type ModelInfo } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { primaryAction } from './derive.js';

type Action = 'cancel' | 'delete' | 're-process' | 'retry-model';

/** Inline confirmation text per action (also the Confirm button's description). */
const PROMPTS: Record<Exclude<Action, 'retry-model'>, (filename: string) => string> = {
  delete: (f) => `Delete ${f}? Published copies in the target are kept.`,
  cancel: () => 'Cancel job?',
  're-process': (f) =>
    `Re-process ${f}? It is extracted again on the latest template version; earlier review edits are discarded.`,
};

const DELETABLE = new Set<JobStatus>(DELETABLE_STATUSES);
const RETRYABLE = new Set<JobStatus>(['failed', 'needs_review', 'cancelled']);
/** Actions that live in the ⋯ menu on a row (focus returns to the ⋯ button). */
const MENU_ACTIONS = new Set<Action>(['delete', 're-process', 'retry-model']);

/**
 * A job's actions. `row`: the main action for its status plus a ⋯ menu; `panel`: everything as
 * buttons. Cancel, Delete, Re-process and Retry-with-another-model confirm inline first; that
 * state is local, so a poll refresh (same job id) keeps it open.
 */
export function JobActions({
  api,
  job,
  onChanged,
  retryModel,
  models,
  variant,
}: {
  api: Api;
  job: JobSummary;
  onChanged: () => void;
  /** Model selected in the upload strip ('' = spec default): Retry and Re-process use it. */
  retryModel: string;
  /** Enabled models for "Retry with another model…". */
  models: readonly ModelInfo[];
  variant: 'row' | 'panel';
}) {
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Fixed position under the ⋯ button: the list box scrolls, so an absolute menu would be clipped. */
  const [menuAt, setMenuAt] = useState<{ top: number; right: number } | null>(null);
  const [picked, setPicked] = useState('');
  const [error, setError] = useState<string | null>(null);
  const menuId = useId();
  const promptId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement | HTMLSelectElement | null>(null);
  const triggers = useRef<Partial<Record<Action, HTMLButtonElement | null>>>({});
  const [returnFocus, setReturnFocus] = useState<Action | 'menu' | null>(null);

  // Keyboard/screen-reader users: focus the confirmation when it opens, and what opened it after.
  useEffect(() => {
    if (confirm) confirmRef.current?.focus();
    else if (returnFocus) {
      const target =
        returnFocus === 'menu' || (variant === 'row' && MENU_ACTIONS.has(returnFocus))
          ? moreButton.current
          : triggers.current[returnFocus];
      target?.focus();
      setReturnFocus(null);
    }
  }, [confirm, returnFocus, variant]);

  // The menu closes on a click anywhere else, and when the page scrolls or resizes under it.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const close = () => setMenuOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menuOpen]);

  const file = job.filename;
  const model = retryModel || 'spec default';

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      setConfirm(null);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const ask = (action: Action) => {
    setMenuOpen(false);
    setError(null);
    if (action === 'retry-model') setPicked(retryModel);
    setConfirm(action);
  };
  const keep = () => {
    setReturnFocus(confirm);
    setConfirm(null);
  };
  const alert = error && (
    <div role="alert" className="error">
      {error}
    </div>
  );

  if (confirm === 'retry-model') {
    return (
      <div className="inline-confirm">
        <select
          ref={(el) => {
            confirmRef.current = el;
          }}
          aria-label={`Model for ${file}`}
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
        >
          <option value="">Spec default</option>
          {models
            .filter((m) => m.enabled)
            .map((m) => (
              <option key={m.ref} value={m.ref}>
                {m.ref}
              </option>
            ))}
        </select>
        <button
          type="button"
          className="primary"
          aria-label={`Confirm retry ${file}`}
          onClick={() => void run(() => api.retryJob(job.id, picked || null))}
        >
          Retry
        </button>
        <button type="button" aria-label={`Keep ${file}`} onClick={keep}>
          Keep
        </button>
        {alert}
      </div>
    );
  }
  if (confirm) {
    return (
      <div className="inline-confirm">
        <span id={promptId}>{PROMPTS[confirm](file)}</span>
        <button
          ref={(el) => {
            confirmRef.current = el;
          }}
          type="button"
          className={confirm === 'delete' ? 'danger-fill' : 'primary'}
          aria-label={`Confirm ${confirm} ${file}`}
          aria-describedby={promptId}
          onClick={() =>
            void run(() =>
              confirm === 'delete'
                ? api.deleteJob(job.id)
                : confirm === 'cancel'
                  ? api.cancelJob(job.id)
                  : api.retryJob(job.id, retryModel || null),
            )
          }
        >
          Confirm
        </button>
        <button type="button" aria-label={`Keep ${file}`} onClick={keep}>
          Keep
        </button>
        {alert}
      </div>
    );
  }

  const trigger = (action: Action) => (el: HTMLButtonElement | null) => {
    triggers.current[action] = el;
  };
  const primary = primaryAction(job);
  const main =
    primary === 'review' ? (
      <a className="button primary" href={`#/review/${job.id}`}>
        {variant === 'panel' ? 'Review & approve' : 'Review'}
      </a>
    ) : primary === 'view' ? (
      <a className="button" href={`#/review/${job.id}`}>
        View
      </a>
    ) : primary === 'retry' ? (
      <button
        type="button"
        aria-label={`Retry with ${model}`}
        onClick={() => void run(() => api.retryJob(job.id, retryModel || null))}
      >
        Retry
      </button>
    ) : primary === 'cancel' ? (
      <button type="button" ref={trigger('cancel')} onClick={() => ask('cancel')}>
        Cancel
      </button>
    ) : null;

  const secondary = (
    <>
      {RETRYABLE.has(job.status) && (
        <button type="button" ref={trigger('retry-model')} onClick={() => ask('retry-model')}>
          Retry with another model…
        </button>
      )}
      {job.status === 'succeeded' && (
        <button
          type="button"
          ref={trigger('re-process')}
          aria-label={`Re-process with ${model}`}
          onClick={() => ask('re-process')}
        >
          Re-process…
        </button>
      )}
      <a className="button" href={api.documentUrl(job.id)} target="_blank" rel="noopener">
        Open PDF
      </a>
      {DELETABLE.has(job.status) && (
        <button
          type="button"
          className="danger"
          ref={trigger('delete')}
          onClick={() => ask('delete')}
        >
          Delete
        </button>
      )}
    </>
  );

  if (variant === 'panel') {
    return (
      <div className="panel-actions">
        {main}
        {secondary}
        {alert}
      </div>
    );
  }
  return (
    <div
      className="row-actions"
      ref={wrapper}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && menuOpen) {
          setMenuOpen(false);
          moreButton.current?.focus();
        }
      }}
    >
      {main}
      <button
        ref={moreButton}
        type="button"
        className="more"
        aria-label={`More actions for ${file}`}
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        onClick={() => {
          const r = moreButton.current?.getBoundingClientRect();
          setMenuAt(r ? { top: r.bottom + 4, right: window.innerWidth - r.right } : null);
          setMenuOpen((o) => !o);
        }}
      >
        <Icon name="more" />
      </button>
      {menuOpen && (
        <div
          id={menuId}
          className="menu"
          role="group"
          aria-label={`Actions for ${file}`}
          style={menuAt ? { top: menuAt.top, right: menuAt.right } : undefined}
        >
          {secondary}
        </div>
      )}
      {alert}
    </div>
  );
}
