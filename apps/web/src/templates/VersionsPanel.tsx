import { useEffect, useId, useRef, useState } from 'react';
import { VERSION_LABEL_MAX, VERSION_NOTE_MAX, versionName } from '@ih/shared';
import type { Api, TemplateRecordView, TemplateVersionItem } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { changeAtText } from './editor-derive.js';

const DIRTY_REASON = 'Save or discard your changes first';

/** "v2 · Published · Two-page letters": a row's name, also its accessible label. */
export const versionRowName = (v: Pick<TemplateVersionItem, 'version' | 'status' | 'label'>) =>
  [`v${v.version}`, v.status === 'draft' ? 'Draft' : 'Published', v.label]
    .filter(Boolean)
    .join(' · ');

/**
 * The recipe's versions (#144), newest first: each with its label and note, editable on drafts
 * and published versions alike (the label is not part of the definition). An earlier version
 * replaces the open draft, or starts the next draft when none is open, which is how a version
 * becomes the latest again: publish the draft.
 */
export function VersionsPanel({
  api,
  templateId,
  openVersion,
  openUpdatedAt,
  dirty,
  retired,
  refreshKey,
  onRestored,
  onStarted,
}: {
  api: Api;
  templateId: string;
  /** The version open in the editor. */
  openVersion: number;
  /** Its `updatedAt` when it is the draft: a replace sends it, so a draft saved since is a 409. */
  openUpdatedAt: string | null;
  /** The editor has unsaved edits: replacing the open draft would lose them. */
  dirty: boolean;
  /** Why nothing can be started (a retired type); labels can still be set. */
  retired: string | null;
  refreshKey: number;
  onRestored: (draft: TemplateRecordView) => void;
  onStarted: (draft: TemplateRecordView) => void;
}) {
  const heading = useId();
  const [versions, setVersions] = useState<TemplateVersionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [replacing, setReplacing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);
  /** Numbers each load, so an older response never replaces a newer one. */
  const request = useRef(0);

  useEffect(() => {
    const n = ++request.current;
    api.listVersions(templateId).then(
      (v) => {
        if (n !== request.current) return;
        setVersions(v);
        setError(null);
      },
      (err: Error) => {
        if (n === request.current) setError(err.message);
      },
    );
  }, [api, templateId, refreshKey, reloads]);

  const draft = versions?.find((v) => v.status === 'draft') ?? null;
  const next = Math.max(0, ...(versions ?? []).map((v) => v.version)) + 1;
  const openDraftDirty = dirty && draft?.version === openVersion;

  const start = async (from: number) => {
    setBusy(true);
    setError(null);
    try {
      onStarted(await api.newDraft(templateId, from));
      setReloads((r) => r + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card versions-panel" aria-labelledby={heading}>
      <h3 id={heading}>Versions</h3>
      <p className="muted">
        Label a version to say what it is for. To go back to a version, copy it into the draft and
        publish that.
      </p>
      {error && <p role="alert">{error}</p>}
      {versions === null && !error && <p className="muted">Loading…</p>}
      {versions !== null && (
        <ul className="versions-list" aria-label="Versions">
          {versions.map((v) => (
            <li key={v.version} aria-label={versionRowName(v)}>
              <div className="version-head">
                <strong>v{v.version}</strong>{' '}
                <span className={`kind-tag ${v.status === 'draft' ? 'tone-info' : 'tone-ok'}`}>
                  {v.status === 'draft' ? 'Draft' : 'Published'}
                </span>{' '}
                {v.label && <span className="version-label">{v.label}</span>}
                <span className="muted version-when">
                  {v.publishedAt
                    ? `published ${changeAtText(v.publishedAt)}`
                    : `saved ${changeAtText(v.updatedAt)}`}
                </span>
              </div>
              {v.note && <p className="version-note">{v.note}</p>}
              {v.labelSetBy && <p className="muted version-by">Labelled by {v.labelSetBy}</p>}
              {editing === v.version ? (
                <LabelForm
                  item={v}
                  onCancel={() => setEditing(null)}
                  onSave={async (body) => {
                    await api.setVersionLabel(templateId, v.version, body);
                    setEditing(null);
                    setReloads((r) => r + 1);
                  }}
                />
              ) : (
                <div className="version-actions">
                  <button
                    type="button"
                    className="link"
                    aria-label={`Edit label of v${v.version}`}
                    onClick={() => setEditing(v.version)}
                  >
                    {v.label || v.note ? 'Edit label' : 'Add label'}
                  </button>
                  {v.version === openVersion ? (
                    <span className="muted">Open in the editor</span>
                  ) : (
                    <a href={`#/templates/${templateId}/${v.version}`}>Open v{v.version}</a>
                  )}
                  {draft && v.version !== draft.version && (
                    <button
                      type="button"
                      disabled={busy || retired !== null || openDraftDirty}
                      title={retired ?? (openDraftDirty ? DIRTY_REASON : undefined)}
                      onClick={() => setReplacing(v.version)}
                    >
                      Replace draft v{draft.version} with v{v.version}
                    </button>
                  )}
                  {!draft && (
                    <button
                      type="button"
                      disabled={busy || retired !== null}
                      title={retired ?? undefined}
                      onClick={() => void start(v.version)}
                    >
                      Start v{next} from v{v.version}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {replacing !== null && draft && (
        <ReplaceDialog
          draft={draft.version}
          from={versions!.find((v) => v.version === replacing)!}
          onClose={() => setReplacing(null)}
          onConfirm={async () => {
            const base = draft.version === openVersion ? (openUpdatedAt ?? undefined) : undefined;
            const view = await api.restoreVersion(templateId, draft.version, replacing, base);
            setReplacing(null);
            setReloads((r) => r + 1);
            onRestored(view);
          }}
        />
      )}
    </section>
  );
}

function LabelForm({
  item,
  onSave,
  onCancel,
}: {
  item: TemplateVersionItem;
  onSave: (body: { label: string | null; note: string | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(item.label ?? '');
  const [note, setNote] = useState(item.note ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      // Blank clears: the API refuses an empty label or note.
      await onSave({ label: label.trim() || null, note: note.trim() || null });
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };
  return (
    <form
      className="version-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={`${formId}-label`}>Label</label>
      <input
        id={`${formId}-label`}
        value={label}
        maxLength={VERSION_LABEL_MAX}
        placeholder="What this version is for"
        onChange={(e) => setLabel(e.target.value)}
      />
      <label htmlFor={`${formId}-note`}>Note</label>
      <textarea
        id={`${formId}-note`}
        value={note}
        maxLength={VERSION_NOTE_MAX}
        rows={3}
        onChange={(e) => setNote(e.target.value)}
      />
      {error && <p role="alert">{error}</p>}
      <div className="version-form-actions">
        <button type="submit" className="primary" disabled={saving}>
          Save label
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ReplaceDialog({
  draft,
  from,
  onConfirm,
  onClose,
}: {
  draft: number;
  from: TemplateVersionItem;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Replace draft v${draft} with v${from.version}?`}
      onClose={onClose}
      actions={
        <button type="button" className="primary" disabled={busy} onClick={() => void confirm()}>
          Replace draft
        </button>
      }
    >
      <p>
        The draft&apos;s recipe becomes a copy of {versionName(from.version, from.label)}. The
        change is logged in the draft&apos;s change log; publish the draft to make it the latest
        version.
      </p>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
