import type { DataPolicy, OverviewItem } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { TabHeader } from '../workbench/TabHeader.js';
import { DraftMenu } from './DraftMenu.js';
import { TryOn } from './TryOn.js';

export const EMBEDDED_NOTE =
  'Edit the draft by hand. Model proposals and your edits change the same draft, so everything here is what the next run uses. Saving marks the latest evaluation as out of date.';

/**
 * The Template tab's header (handoff §10): no back link or name (the project header owns them);
 * *Try on → Test run*, Export YAML, *More → Delete draft* and Publish vN, which publishes through
 * the Workbench route (the gate is informational and never locks it).
 */
export function EmbeddedHeader({
  api,
  templateId,
  version,
  status,
  dirty,
  dataPolicy,
  issues,
  item,
  exportUrl,
  publishBlocker,
  onQueued,
  onPublish,
  onNewDraft,
  onDeleteDraft,
}: {
  api: Api;
  templateId: string;
  version: number;
  status: 'draft' | 'published';
  dirty: boolean;
  dataPolicy: DataPolicy;
  issues: number;
  /** The overview's Template item: the status line (null while unknown). */
  item: OverviewItem | null;
  exportUrl: string;
  /** Why Publish cannot run (unsaved edits, validation issues); null when it can. */
  publishBlocker: string | null;
  onQueued: () => void;
  onPublish: () => void;
  onNewDraft: () => void;
  onDeleteDraft: () => void;
}) {
  const draft = status === 'draft';
  return (
    <TabHeader
      title={draft ? `Template · draft v${version}` : `Template · v${version}`}
      item={item}
      description={EMBEDDED_NOTE}
      actions={
        <>
          {draft && (
            <TryOn
              api={api}
              projectId={templateId}
              version={version}
              dirty={dirty}
              dataPolicy={dataPolicy}
              issues={issues}
              onQueued={onQueued}
            />
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
                disabled={publishBlocker !== null}
                title={publishBlocker ?? undefined}
                onClick={onPublish}
              >
                Publish v{version}
              </button>
            </>
          ) : (
            <button type="button" className="primary" onClick={onNewDraft}>
              New draft from v{version}
            </button>
          )}
        </>
      }
    />
  );
}
