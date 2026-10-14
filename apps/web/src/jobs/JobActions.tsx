import { useEffect, useId, useRef, useState } from 'react';
import { DELETABLE_STATUSES, type JobStatus, type JobSummary, type ModelChoice } from '@ih/shared';
import type { Api } from '../api/client.js';
import { isWordDocument } from '../documents.js';
import { Icon } from '../ui/Icon.js';
import { typeModelLabel } from '../ui/ModelPicker.js';
import { ReprocessDialog } from '../ui/ReprocessDialog.js';
import { menuPosition, primaryAction } from './derive.js';

type Action = 'cancel' | 'delete' | 'retry' | 're-process';
/** Confirmed inline; Retry and Re-process open the re-process dialog. */
type InlineAction = 'cancel' | 'delete';

/** Inline confirmation text per action (also the Confirm button's description). */
const PROMPTS: Record<InlineAction, (filename: string) => string> = {
  delete: (f) => `Delete ${f}? Published outputs and its graph are withdrawn.`,
  cancel: () => 'Cancel job?',
};

/** What a retry or re-process runs, said in its dialog. */
const RUNS: Record<'retry' | 're-process', (filename: string) => string> = {
  retry: (f) => `${f} runs again from the start, on the latest version of its document type.`,
  're-process': (f) =>
    `${f} is extracted again on the latest recipe version; earlier review edits are discarded.`,
};

const DELETABLE = new Set<JobStatus>(DELETABLE_STATUSES);
/** Actions that live in the ⋯ menu on a row (focus returns to the ⋯ button). */
const MENU_ACTIONS = new Set<Action>(['delete', 're-process']);

/**
 * A job's actions. `row`: the main action for its status plus a ⋯ menu; `panel`: everything as
 * buttons. Cancel and Delete confirm inline first; Retry and Re-process open the re-process
 * dialog (what runs, and the model choice to run it with). That state is local, so a poll
 * refresh (same job id) keeps it open.
 */
export function JobActions({
  api,
  job,
  onChanged,
  models,
  typeModel,
  variant,
}: {
  api: Api;
  job: JobSummary;
  onChanged: () => void;
  /** The model choices Retry and Re-process offer. */
  models: readonly ModelChoice[];
  /** The job's document type's model, to name the "no override" option (unknown: unnamed). */
  typeModel?: { model?: string };
  variant: 'row' | 'panel';
}) {
  const [confirm, setConfirm] = useState<InlineAction | null>(null);
  const [dialog, setDialog] = useState<'retry' | 're-process' | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Fixed position under the ⋯ button: the list box scrolls, so an absolute menu would be clipped. */
  const [menuAt, setMenuAt] = useState<ReturnType<typeof menuPosition> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuId = useId();
  const promptId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
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
    if (action === 'retry' || action === 're-process') setDialog(action);
    else setConfirm(action);
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
            void run(() => (confirm === 'delete' ? api.deleteJob(job.id) : api.cancelJob(job.id)))
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
        ref={trigger('retry')}
        aria-label={`Retry ${file}`}
        onClick={() => ask('retry')}
      >
        Retry…
      </button>
    ) : primary === 'cancel' ? (
      <button type="button" ref={trigger('cancel')} onClick={() => ask('cancel')}>
        Cancel
      </button>
    ) : null;

  const secondary = (
    <>
      {job.status === 'succeeded' && (
        <button
          type="button"
          ref={trigger('re-process')}
          aria-label={`Re-process ${file}`}
          onClick={() => ask('re-process')}
        >
          Re-process…
        </button>
      )}
      {isWordDocument(job.contentType) ? (
        // Served as an attachment: download in place rather than opening a blank tab.
        <a className="button" href={api.documentUrl(job.id)} download>
          Download original (.docx)
        </a>
      ) : (
        <a className="button" href={api.documentUrl(job.id)} target="_blank" rel="noopener">
          Open PDF
        </a>
      )}
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

  const reprocess = dialog && (
    <ReprocessDialog
      title={`${dialog === 'retry' ? 'Retry' : 'Re-process'} ${file}`}
      confirmLabel={dialog === 'retry' ? 'Retry' : 'Re-process'}
      choices={models}
      initialModel={job.modelOverride ?? ''}
      emptyLabel={typeModelLabel(models, typeModel)}
      summary={<p>{RUNS[dialog](file)}</p>}
      onConfirm={async (model) => {
        await api.retryJob(job.id, model);
        onChanged();
      }}
      onClose={() => {
        setReturnFocus(dialog);
        setDialog(null);
      }}
    />
  );

  if (variant === 'panel') {
    return (
      <div className="panel-actions">
        {main}
        {secondary}
        {alert}
        {reprocess}
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
          setMenuAt(
            r ? menuPosition(r, { width: window.innerWidth, height: window.innerHeight }) : null,
          );
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
          style={menuAt ?? undefined}
        >
          {secondary}
        </div>
      )}
      {alert}
      {reprocess}
    </div>
  );
}
