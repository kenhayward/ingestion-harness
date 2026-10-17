import { useEffect, useId, useState, type FormEvent } from 'react';
import type { SyncSettingsView } from '@ih/shared';
import type { Api } from '../api/client.js';

/**
 * Administration > Integration: how this deployment appears in GitHub when recipe versions are
 * pushed (its name and the default folder). The name is fixed once anything has been pushed.
 */
export function GitHubSyncSection({ api }: { api: Api }) {
  const nameId = useId();
  const rootId = useId();
  const headingId = useId();
  const [settings, setSettings] = useState<SyncSettingsView | null>(null);
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.getGitHubSettings().then(
      (s) => {
        if (!live) return;
        setSettings(s);
        setName(s.instanceName);
        setRoot(s.defaultRoot);
      },
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [api]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.setGitHubSettings({
        instanceName: name.trim(),
        defaultRoot: root.trim(),
      });
      setSettings(next);
      setName(next.instanceName);
      setRoot(next.defaultRoot);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="s3-keys" aria-labelledby={headingId}>
      <div>
        <h2 id={headingId}>GitHub sync</h2>
        <p className="muted">
          How this deployment is named in GitHub when recipe versions are pushed there, so several
          deployments can share one repository.
        </p>
      </div>
      {settings && (
        <form
          className="card-form"
          onSubmit={(e) => void save(e)}
          aria-label="GitHub sync settings"
        >
          <div className="field">
            <label htmlFor={nameId}>Deployment name</label>
            <small className="muted">
              {settings.locked
                ? 'Fixed once this deployment has pushed to GitHub.'
                : 'Lower-case letters, digits and hyphens. Fixed once this deployment has pushed.'}
            </small>
            <input
              id={nameId}
              value={name}
              readOnly={settings.locked}
              maxLength={63}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor={rootId}>Default folder</label>
            <small className="muted">
              The folder in a repository that holds the deployments' folders; a link can use
              another.
            </small>
            <input
              id={rootId}
              value={root}
              onChange={(e) => {
                setRoot(e.target.value);
                setSaved(false);
              }}
            />
          </div>
          <div className="field">
            <span className="field-label">Deployment id</span>
            <small className="muted">
              Finds this deployment's folder even if the name changes.
            </small>
            <span className="mono">{settings.instanceId}</span>
          </div>
          <button type="submit" className="primary" disabled={busy || !name.trim() || !root.trim()}>
            Save
          </button>
          {saved && (
            <span role="status" className="muted">
              Saved.
            </span>
          )}
        </form>
      )}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </section>
  );
}
