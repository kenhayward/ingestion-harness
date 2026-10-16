import { useEffect, useState } from 'react';
import type { Api, GitHubSyncView } from '../../api/client.js';
import { LinkDialog } from './LinkDialog.js';

/**
 * The top of the Versions list: where the type is stored on GitHub, with *Change…* (admins) and
 * *Pull from GitHub…*, or *Link to GitHub…* for an admin when it is not linked. Everyone else sees
 * nothing for an unlinked type. Only admins can read the instance name, so others see the root.
 */
export function GitHubStrip({
  api,
  templateId,
  admin,
  sync,
  onChanged,
  onPull,
}: {
  api: Api;
  templateId: string;
  admin: boolean;
  /** The type's link and version states; null while loading or when sync is unavailable. */
  sync: GitHubSyncView | null;
  /** The link was saved or removed. */
  onChanged: () => void;
  /** Opens the pull dialog; the button is hidden without it. */
  onPull?: () => void;
}) {
  const [instance, setInstance] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);

  useEffect(() => {
    if (!admin) return;
    let live = true;
    api.getGitHubSettings().then(
      (s) => {
        if (live) setInstance(s.instanceName);
      },
      () => {}, // the folder just reads shorter
    );
    return () => {
      live = false;
    };
  }, [api, admin]);

  if (!sync) return null;
  const { link } = sync;
  if (!link && !admin) return null;
  const folder = link
    ? `${link.root}/${admin && instance ? `${instance}/${templateId}/` : ''}`
    : '';
  return (
    <div className="github-strip">
      {link ? (
        <>
          <span>{`GitHub: ${link.repo} · ${link.branch} · ${folder}`}</span>
          {admin && (
            <button type="button" onClick={() => setDialog(true)}>
              Change…
            </button>
          )}
          {onPull && (
            <button type="button" onClick={onPull}>
              Pull from GitHub…
            </button>
          )}
        </>
      ) : (
        <button type="button" onClick={() => setDialog(true)}>
          Link to GitHub…
        </button>
      )}
      {dialog && (
        <LinkDialog
          api={api}
          templateId={templateId}
          link={link}
          onClose={() => setDialog(false)}
          onSaved={() => {
            setDialog(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
