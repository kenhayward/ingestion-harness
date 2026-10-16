import { useEffect, useId, useState } from 'react';
import type { RemoteCompare, RemoteListingView, RemoteVersionView } from '@ih/shared';
import type { Api, TemplateRecordView } from '../../api/client.js';
import { Dialog } from '../../ui/Dialog.js';
import { RepoBrowser, remoteKey } from './RepoBrowser.js';

const DIRTY_REASON = 'Save or discard your changes first';

const COMPARE_TEXT: Record<RemoteCompare, string> = {
  same: 'Same as here',
  label: 'Label differs',
  differs: 'Different from here',
  'missing-here': 'Not here',
};

/**
 * Pulls from the type's GitHub folder: this deployment's versions with how they compare (and
 * *Take GitHub's label* where only the label differs), and other deployments' versions, which
 * can become the draft. Pulling never publishes.
 */
export function PullDialog({
  api,
  templateId,
  retired,
  dirty,
  openUpdatedAt,
  onTaken,
  onDraft,
  onClose,
}: {
  api: Api;
  templateId: string;
  /** Why nothing can be started (a retired type), or null. */
  retired: string | null;
  /** The editor has unsaved edits: replacing the draft would lose them. */
  dirty: boolean;
  /** The open draft's `updatedAt`, sent so a draft saved since is a 409; null without a draft. */
  openUpdatedAt: string | null;
  /** A label was copied onto a published version. */
  onTaken: (version: TemplateRecordView) => void;
  /** A version on GitHub was written into the draft. */
  onDraft: (draft: TemplateRecordView) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<RemoteListingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const reasonId = useId();

  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let live = true;
    api.listGitHubRemote(templateId).then(
      (l) => {
        if (live) setListing(l);
      },
      (err: Error) => {
        if (live) setError(err.message);
      },
    );
    return () => {
      live = false;
    };
  }, [api, templateId, reloads]);

  const reason = retired ?? (dirty ? DIRTY_REASON : null);

  const act = async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const mine = listing?.versions.filter((v) => v.mine) ?? [];
  const others = listing?.versions.filter((v) => !v.mine) ?? [];
  const byKey = new Map((listing?.versions ?? []).map((v) => [remoteKey(v), v]));

  const actions = (v: RemoteVersionView) => {
    const key = remoteKey(v);
    const commit = byKey.get(key)?.commit ?? null;
    return (
      <span className="repo-actions">
        {v.mine && v.compare && <span className="kind-tag">{COMPARE_TEXT[v.compare]}</span>}
        {v.mine && v.compare === 'label' && commit && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void act(key, async () => {
                onTaken(await api.takeGitHubLabel(templateId, v.version, commit));
                setReloads((r) => r + 1);
              })
            }
          >
            Take GitHub&apos;s label
          </button>
        )}
        {commit && (!v.mine || v.compare === 'missing-here') && (
          <>
            <button
              type="button"
              disabled={busy !== null || reason !== null}
              aria-describedby={reason ? `${reasonId}-${key}` : undefined}
              onClick={() =>
                void act(key, async () => {
                  const draft = await api.useGitHubVersionAsDraft(templateId, {
                    instance: v.instance,
                    typeId: v.typeId,
                    version: v.version,
                    commit,
                    ...(openUpdatedAt ? { baseUpdatedAt: openUpdatedAt } : {}),
                  });
                  onDraft(draft);
                })
              }
            >
              Use as draft…
            </button>
            {reason && (
              <span id={`${reasonId}-${key}`} className="muted">
                {reason}
              </span>
            )}
          </>
        )}
      </span>
    );
  };

  return (
    <Dialog title="Pull from GitHub" onClose={onClose}>
      {error && <p role="alert">{error}</p>}
      {listing === null && !error && <p className="muted">Loading…</p>}
      {listing !== null && (
        <>
          <section aria-label="This deployment">
            <h3>This deployment</h3>
            <RepoBrowser listing={{ versions: mine, skipped: [] }} actions={actions} />
          </section>
          <section aria-label="Other deployments">
            <h3>Other deployments</h3>
            <RepoBrowser listing={{ versions: others, skipped: [] }} actions={actions} />
          </section>
          {listing.skipped.length > 0 && (
            <section aria-label="Not readable">
              <h3>Not readable</h3>
              <ul>
                {listing.skipped.map((s) => (
                  <li key={s.path}>
                    <span className="mono">{s.path}</span>: {s.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </Dialog>
  );
}
