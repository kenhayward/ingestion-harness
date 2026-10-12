import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon.js';
import { publishBlocker } from './editor-derive.js';

/**
 * Editor header (UI handoff §5): what is being edited and where it came from, unsaved state, and
 * the version actions. Publish says why it can't publish; Delete draft confirms inline.
 */
export function EditorHeader({
  name,
  id,
  version,
  status,
  publishedVersion,
  dirty,
  issues,
  exportUrl,
  onSave,
  onPublish,
  onNewDraft,
  onDeleteDraft,
}: {
  name: string;
  id: string;
  version: number;
  status: 'draft' | 'published';
  /** Latest published version of this type (null: never published). */
  publishedVersion: number | null;
  dirty: boolean;
  issues: number;
  exportUrl: string;
  onSave: () => void;
  onPublish: () => void;
  onNewDraft: () => void;
  onDeleteDraft: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [returnFocus, setReturnFocus] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const draft = status === 'draft';
  const blocker = publishBlocker(dirty, issues);

  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
    else if (returnFocus) {
      more.current?.focus();
      setReturnFocus(false);
    }
  }, [confirming, returnFocus]);

  return (
    <header className="editor-header">
      <div>
        <a className="back-link" href="#/templates">
          <Icon name="chevronLeft" />
          Document types
        </a>
        <div className="editor-title">
          <h1>{name}</h1>
          <span className={draft ? 'pill tone-info' : 'pill tone-ok'}>
            {draft ? 'Draft' : 'Published'} v{version}
          </span>
          <span className="muted">
            {draft && publishedVersion !== null && publishedVersion < version
              ? `from published v${publishedVersion} · ${id}`
              : id}
          </span>
        </div>
      </div>
      <div className="editor-actions">
        {dirty && (
          <span className="unsaved">
            <span className="live-dot" aria-hidden="true" />
            Unsaved changes
          </span>
        )}
        <a
          className="button icon bordered"
          href={exportUrl}
          aria-label="Export YAML"
          title="Export YAML"
        >
          <Icon name="download" />
        </a>
        {draft ? (
          <>
            <div className="menu-anchor">
              <button
                ref={more}
                type="button"
                className="icon bordered"
                aria-label="More actions"
                aria-expanded={menu}
                onClick={() => setMenu((m) => !m)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setMenu(false);
                }}
              >
                <Icon name="more" />
              </button>
              {menu && (
                <div className="menu menu-down" role="group" aria-label="More actions">
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setMenu(false);
                      setConfirming(true);
                    }}
                  >
                    Delete draft
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              disabled={blocker !== null}
              title={blocker ?? undefined}
              onClick={onPublish}
            >
              Publish v{version}
            </button>
            <button type="button" className="primary" disabled={!dirty} onClick={onSave}>
              Save draft
            </button>
          </>
        ) : (
          <button type="button" className="primary" onClick={onNewDraft}>
            New draft from v{version}
          </button>
        )}
      </div>
      {draft && blocker && !dirty && <p className="publish-reason">{blocker}</p>}
      {confirming && (
        <div className="inline-confirm delete-confirm" role="group" aria-label="Confirm delete">
          <span>Delete draft v{version}? This cannot be undone.</span>
          <button
            ref={confirmButton}
            type="button"
            className="danger-fill"
            onClick={() => {
              setConfirming(false);
              onDeleteDraft();
            }}
          >
            Delete draft v{version}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              setReturnFocus(true);
            }}
          >
            Keep
          </button>
        </div>
      )}
    </header>
  );
}
