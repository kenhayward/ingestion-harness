import { useEffect, useId, useState, type FormEvent } from 'react';
import { DEFAULT_SYNC_ROOT, type RemoteListing, type RemoteVersion } from '@ih/shared';
import type { Api } from '../../api/client.js';
import { Dialog } from '../../ui/Dialog.js';
import { RepoBrowser } from './RepoBrowser.js';

/**
 * Creates a new document type from a recipe version on GitHub (a v1 draft). One browser over the
 * repository: pick a version, check the id and name, import. Admins can also link the new type
 * to the repository, which writes under this deployment's own folder.
 */
export function ImportDialog({
  api,
  admin,
  onOpened,
  onClose,
}: {
  api: Api;
  admin: boolean;
  /** The new draft's id and version, to open in the editor. */
  onOpened: (id: string, version: number) => void;
  onClose: () => void;
}) {
  const formId = useId();
  const [repos, setRepos] = useState<string[] | null>(null);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [root, setRoot] = useState(DEFAULT_SYNC_ROOT);
  const [instance, setInstance] = useState<string | null>(null);
  const [listing, setListing] = useState<RemoteListing | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [picked, setPicked] = useState<RemoteVersion | null>(null);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [link, setLink] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The folder the link would write under, once known (admins). */
  const [linkRoot, setLinkRoot] = useState(DEFAULT_SYNC_ROOT);

  useEffect(() => {
    let live = true;
    Promise.all([
      api.listReadableGitHubRepos(),
      api.getProfile().catch(() => null),
      admin ? api.getGitHubSettings().catch(() => null) : Promise.resolve(null),
    ]).then(
      ([list, profile, settings]) => {
        if (!live) return;
        const pick = profile?.github?.repo ?? null;
        const names = list.map((r) => r.fullName);
        setSuggested(pick);
        setRepos(names);
        setRepo((current) => current || pick || names[0] || '');
        if (settings) {
          setRoot(settings.defaultRoot);
          setLinkRoot(settings.defaultRoot);
          setInstance(settings.instanceName);
        }
      },
      (err: Error) => {
        if (!live) return;
        setRepos([]);
        setError(err.message);
      },
    );
    return () => {
      live = false;
    };
  }, [api, admin]);

  const options = (() => {
    const names = new Set(repos ?? []);
    if (suggested) names.add(suggested);
    const rest = [...names].filter((n) => n !== suggested).sort();
    return suggested ? [suggested, ...rest] : rest;
  })();

  const browse = async () => {
    if (!repo || browsing) return;
    setBrowsing(true);
    setError(null);
    setPicked(null);
    try {
      setListing(await api.browseGitHub({ repo, branch: branch.trim(), root: root.trim() }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBrowsing(false);
    }
  };

  const pick = (v: RemoteVersion) => {
    setPicked(v);
    setId(v.typeId);
    setName(v.typeId);
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!picked || !picked.commit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const made = await api.importFromGitHub({
        repo,
        branch: branch.trim(),
        path: picked.path,
        commit: picked.commit,
        id: id.trim(),
        name: name.trim(),
        link: admin && link,
      });
      onOpened(made.record.id, made.record.version);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Import from GitHub"
      onClose={onClose}
      actions={
        <button
          type="submit"
          form={formId}
          className="primary"
          disabled={busy || !picked || !picked.commit || !id.trim() || !name.trim()}
        >
          Import
        </button>
      }
    >
      <div className="dialog-form">
        <label>
          Repository
          <select value={repo} onChange={(e) => setRepo(e.target.value)} disabled={repos === null}>
            {options.map((n) => (
              <option key={n} value={n}>
                {n === suggested ? `${n} (suggested repository)` : n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Branch
          <input value={branch} maxLength={250} onChange={(e) => setBranch(e.target.value)} />
        </label>
        <label>
          Folder
          <input value={root} onChange={(e) => setRoot(e.target.value)} />
        </label>
        <div>
          <button type="button" disabled={!repo || browsing} onClick={() => void browse()}>
            Browse
          </button>
        </div>
      </div>
      {listing && <RepoBrowser listing={listing} picked={picked} onPick={pick} />}
      {picked && (
        <form
          id={formId}
          className="dialog-form"
          aria-label="Import"
          onSubmit={(e) => void submit(e)}
        >
          <label>
            Id
            <input className="mono" value={id} onChange={(e) => setId(e.target.value)} />
          </label>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {admin && (
            <>
              <label className="check">
                <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} />{' '}
                Keep it in sync with this repository
              </label>
              <small className="muted">
                {`It will write under ${linkRoot}/${instance ?? 'this instance'}/, never ${picked.instance}/.`}
              </small>
            </>
          )}
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
