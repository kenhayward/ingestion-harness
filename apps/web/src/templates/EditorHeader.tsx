import { Icon } from '../ui/Icon.js';
import { RETIRED_REASON } from '../ui/retired.js';
import { DraftMenu } from './DraftMenu.js';
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
  saving = false,
  retired = false,
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
  saving?: boolean;
  /** The document type is retired: read-only, nothing new runs (D17). */
  retired?: boolean;
  onSave: () => void;
  onPublish: () => void;
  onNewDraft: () => void;
  onDeleteDraft: () => void;
}) {
  const draft = status === 'draft';
  const blocker = publishBlocker(dirty, issues, retired);

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
            <DraftMenu version={version} onDelete={onDeleteDraft} />
            <button
              type="button"
              disabled={blocker !== null}
              title={blocker ?? undefined}
              onClick={onPublish}
            >
              Publish v{version}
            </button>
            <button
              type="button"
              className="primary"
              disabled={retired || !dirty || saving}
              title={retired ? RETIRED_REASON : saving ? 'Saving…' : undefined}
              onClick={onSave}
            >
              Save draft
            </button>
          </>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={retired}
            title={retired ? RETIRED_REASON : undefined}
            onClick={onNewDraft}
          >
            New draft from v{version}
          </button>
        )}
      </div>
      {draft && blocker && !dirty && <p className="publish-reason">{blocker}</p>}
    </header>
  );
}
