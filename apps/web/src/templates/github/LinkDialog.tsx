import { useEffect, useId, useState, type FormEvent } from 'react';
import { DEFAULT_SYNC_ROOT, type GitHubLinkView } from '@ih/shared';
import type { Api } from '../../api/client.js';
import { Dialog } from '../../ui/Dialog.js';
import { HelpButton } from '../../ui/Help.js';

export const LINK_ACCOUNT_FIRST = 'Link your GitHub account in Profile first';

/**
 * Links a document type to a GitHub repository, changes the link, or removes it (admins). The
 * repositories are the ones the signed-in account can push to; the one chosen in Profile comes
 * first as the suggested repository. A new link starts in Integration's default folder.
 */
export function LinkDialog({
  api,
  templateId,
  link,
  onSaved,
  onClose,
}: {
  api: Api;
  templateId: string;
  /** The current link, or null to create one. */
  link: GitHubLinkView | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const formId = useId();
  const [repos, setRepos] = useState<string[] | null>(null);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [repo, setRepo] = useState(link?.repo ?? '');
  const [branch, setBranch] = useState(link?.branch ?? 'main');
  const [root, setRoot] = useState(link?.root ?? DEFAULT_SYNC_ROOT);
  const [alwaysPr, setAlwaysPr] = useState(link?.alwaysPr ?? false);
  const [pushOnPublish, setPushOnPublish] = useState(link?.pushOnPublish ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The signed-in admin has no linked GitHub account: there is nothing to choose from. */
  const [unlinked, setUnlinked] = useState(false);
  const isNew = link === null;

  useEffect(() => {
    let live = true;
    api
      .getProfile()
      .catch(() => null)
      .then(async (profile) => {
        if (profile && !profile.github) {
          if (live) setUnlinked(true);
          return;
        }
        const list = await api.listGitHubRepos();
        if (!live) return;
        const pick = profile?.github?.repo ?? null;
        const names = list.map((r) => r.fullName);
        setSuggested(pick);
        setRepos(names);
        setRepo((current) => current || pick || names[0] || '');
      })
      .catch((err: Error) => {
        if (!live) return;
        setRepos([]);
        setError(err.message);
      });
    if (isNew) {
      api.getGitHubSettings().then(
        (s) => {
          if (live) setRoot((current) => (current === DEFAULT_SYNC_ROOT ? s.defaultRoot : current));
        },
        () => {}, // the built-in default stays
      );
    }
    return () => {
      live = false;
    };
  }, [api, isNew]);

  const complete = branch.trim() !== '' && root.trim() !== '';

  // The suggestion first, then the rest; a repository already linked stays choosable.
  const options = (() => {
    const names = new Set(repos ?? []);
    if (link) names.add(link.repo);
    if (suggested) names.add(suggested);
    const rest = [...names].filter((n) => n !== suggested).sort();
    return suggested ? [suggested, ...rest] : rest;
  })();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !repo || !complete || unlinked) return;
    setBusy(true);
    setError(null);
    try {
      await api.setGitHubLink(templateId, {
        repo,
        branch: branch.trim(),
        root: root.trim(),
        alwaysPr,
        pushOnPublish,
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const unlink = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.removeGitHubLink(templateId);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={link ? 'GitHub link' : 'Link to GitHub'}
      onClose={onClose}
      actions={
        <>
          {link && (
            <button type="button" disabled={busy} onClick={() => void unlink()}>
              Unlink
            </button>
          )}
          <button
            type="submit"
            form={formId}
            className="primary"
            disabled={busy || !repo || !complete || unlinked}
          >
            {link ? 'Save' : 'Link'}
          </button>
        </>
      }
    >
      <HelpButton topic="github-sync" />
      <form
        id={formId}
        className="dialog-form"
        aria-label="GitHub link"
        onSubmit={(e) => void submit(e)}
      >
        {unlinked ? (
          <p className="muted">{LINK_ACCOUNT_FIRST}</p>
        ) : (
          <label>
            Repository
            <select
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              disabled={repos === null}
            >
              {options.map((name) => (
                <option key={name} value={name}>
                  {name === suggested ? `${name} (suggested repository)` : name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Branch
          <input value={branch} maxLength={250} onChange={(e) => setBranch(e.target.value)} />
        </label>
        <label>
          Folder
          <input value={root} onChange={(e) => setRoot(e.target.value)} />
        </label>
        {!complete && <small className="muted">Name the branch and the folder.</small>}
        <label className="check">
          <input
            type="checkbox"
            checked={alwaysPr}
            onChange={(e) => setAlwaysPr(e.target.checked)}
          />{' '}
          Always open a pull request
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={pushOnPublish}
            onChange={(e) => setPushOnPublish(e.target.checked)}
          />{' '}
          Push each version when it&apos;s published
        </label>
        {error && <p role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
