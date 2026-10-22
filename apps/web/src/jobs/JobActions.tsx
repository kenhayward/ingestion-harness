import { useEffect, useId, useRef, useState } from 'react';
import { DELETABLE_STATUSES, type JobStatus, type JobSummary, type ModelChoice } from '@ih/shared';
import type { Api } from '../api/client.js';
import { isWordDocument } from '../documents.js';
import { Icon } from '../ui/Icon.js';
import { typeModelLabel } from '../ui/ModelPicker.js';
import { jobHash } from '../router.js';
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

/**
 * A job's actions. `row`: a ⋯ menu holding all of them, the main one for its status first, so
 * the row stays one line (a confirmation, a copied link or an error opens where the menu was);
 * `panel`: everything as buttons. Cancel and Delete confirm first; Retry and Re-process open
 * the re-process dialog (what runs, and the model choice to run it with). That state is local,
 * so a poll refresh (same job id) keeps it open.
 */
export function JobActions({
  api,
  job,
  onChanged,
  models,
  typeModel,
  variant,
  staysIn = [],
}: {
  api: Api;
  job: JobSummary;
  onChanged: () => void;
  /** The model choices Retry and Re-process offer. */
  models: readonly ModelChoice[];
  /** The job's document type's model, to name the "no override" option (unknown: unnamed). */
  typeModel?: { model?: string };
  variant: 'row' | 'panel';
  /** Targets the job was delivered to that can't withdraw: deleting says what stays there. */
  staysIn?: readonly string[];
}) {
  const [confirm, setConfirm] = useState<InlineAction | null>(null);
  const [dialog, setDialog] = useState<'retry' | 're-process' | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Fixed position under the ⋯ button: the list box scrolls, so an absolute menu would be clipped. */
  const [menuAt, setMenuAt] = useState<ReturnType<typeof menuPosition> | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Copy link: `copied` briefly after a copy; `manualLink` when the browser cannot copy. */
  const [copied, setCopied] = useState(false);
  const [manualLink, setManualLink] = useState<string | null>(null);
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
      // On a row every action is in the menu, gone once picked: back to its ⋯ button.
      const target =
        returnFocus === 'menu' || variant === 'row'
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

  // On a row, the link to copy by hand opens over the list: a click elsewhere closes it.
  useEffect(() => {
    if (!manualLink || variant !== 'row') return;
    const onDown = (e: MouseEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setManualLink(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [manualLink, variant]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  const file = job.filename;

  /** A link to this job's page to send someone; shown to copy by hand when the browser cannot
   * (the clipboard API needs HTTPS: on plain-HTTP LAN access it doesn't exist). */
  const copyLink = () => {
    setMenuOpen(false);
    setManualLink(null);
    const url = `${window.location.origin}${window.location.pathname}${jobHash(job.id)}`;
    if (!navigator.clipboard) {
      setManualLink(url);
      return;
    }
    navigator.clipboard.writeText(url).then(
      () => setCopied(true),
      () => setManualLink(url),
    );
  };

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
  const linkNote = (
    <>
      {copied && (
        <span role="status" className="muted copy-note">
          Link copied
        </span>
      )}
      {manualLink && (
        <input
          className="mono copy-link"
          readOnly
          aria-label={`Link to ${file}`}
          value={manualLink}
          onFocus={(e) => e.target.select()}
          autoFocus
        />
      )}
    </>
  );

  const confirmBox = confirm && (
    <div className="inline-confirm">
      <span id={promptId}>
        {PROMPTS[confirm](file)}
        {confirm === 'delete' && staysIn.length > 0
          ? ` This content stays in ${staysIn.join(', ')}.`
          : ''}
      </span>
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
  if (confirmBox && variant === 'panel') return confirmBox;

  const trigger = (action: Action) => (el: HTMLButtonElement | null) => {
    triggers.current[action] = el;
  };
  const primary = primaryAction(job);
  const main =
    primary === 'review' ? (
      <a className={variant === 'panel' ? 'button primary' : 'button'} href={`#/review/${job.id}`}>
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
      <button type="button" aria-label={`Copy link to ${file}`} onClick={copyLink}>
        Copy link
      </button>
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
        {linkNote}
        {alert}
        {reprocess}
      </div>
    );
  }
  // A row's confirmation, copied-link note, link to copy by hand or error: where the menu was.
  const popover =
    confirmBox ??
    (copied || manualLink || error ? (
      <>
        {linkNote}
        {alert}
      </>
    ) : null);
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
          setConfirm(null);
          setManualLink(null);
          setError(null);
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
          {main}
          {secondary}
        </div>
      )}
      {!menuOpen && popover && (
        <div className="menu row-popover" style={menuAt ?? undefined}>
          {popover}
        </div>
      )}
      {reprocess}
    </div>
  );
}
