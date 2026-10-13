import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { Api, Me } from '../api/client.js';
import { API_DOCS } from '../shell/AppShell.js';
import { pageTitle } from '../shell/derive.js';
import { useDocumentTitle } from '../shell/useDocumentTitle.js';
import { BrandMark } from '../ui/BrandMark.js';
import { Icon } from '../ui/Icon.js';
import { ThemeSwitch } from '../ui/ThemeSwitch.js';

function message(err: unknown): string {
  const status = (err as { status?: number }).status;
  if (status === 401) return 'That token is invalid or has expired.';
  if (status === 429) return 'Too many attempts. Try again in a few minutes.';
  return `Sign-in failed: ${(err as Error).message}`;
}

/** Full-screen layout outside the app shell: sign in, loading, server unreachable. */
export function AuthLayout({
  title = null,
  children,
}: {
  title?: string | null;
  children: ReactNode;
}) {
  useDocumentTitle(pageTitle(title));
  return (
    <div className="auth">
      <div className="auth-top">
        <ThemeSwitch />
      </div>
      <main className="auth-main">
        <div className="auth-column">
          <div className="auth-brand">
            <BrandMark size={52} />
            <h1>CT Studio</h1>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

/** Token entry screen (ADR 0006): a valid token opens a session cookie. */
export function SignIn({
  api,
  ended,
  onSignedIn,
}: {
  api: Api;
  /** The previous session ended (expired, revoked or the admin token rotated). */
  ended: boolean;
  onSignedIn: (me: Me) => void;
}) {
  const fieldId = useId();
  const [token, setToken] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.login(token.trim()));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Sign in">
      <form className="card auth-card" onSubmit={submit} aria-label="Sign in">
        {ended && (
          <div role="status" className="callout tone-info">
            <Icon name="clock" size={18} />
            <span>
              <strong>Your session has ended</strong>
              <span>
                It expired, was revoked, or the admin token rotated. Sign in again to continue.
              </span>
            </span>
          </div>
        )}
        <div className="token-field">
          <label htmlFor={fieldId}>Access token</label>
          <span className={error ? 'token-input invalid' : 'token-input'}>
            <Icon name="key" size={18} />
            <input
              id={fieldId}
              type={shown ? 'text' : 'password'}
              autoComplete="off"
              autoFocus
              spellCheck={false}
              placeholder="Paste your token"
              aria-invalid={error !== null}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setError(null);
              }}
            />
            <button
              type="button"
              className="icon"
              aria-label={shown ? 'Hide token' : 'Show token'}
              aria-pressed={shown}
              onClick={() => setShown((s) => !s)}
            >
              <Icon name={shown ? 'eyeOff' : 'eye'} size={18} />
            </button>
          </span>
        </div>
        {error && (
          <p role="alert" className="field-error">
            <Icon name="alert" />
            {error}
          </p>
        )}
        <button type="submit" className="primary block" disabled={busy || !token.trim()}>
          Sign in
        </button>
      </form>
      <p className="auth-hint">
        Ask an administrator for an access token.
        <br />
        Administrators: the admin token is printed in the API log on each restart.
        <br />
        <a href={API_DOCS} target="_blank" rel="noopener">
          API docs<span className="visually-hidden"> (opens in a new tab)</span>
        </a>
      </p>
    </AuthLayout>
  );
}
