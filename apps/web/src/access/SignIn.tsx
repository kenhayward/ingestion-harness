import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { Api, SignedIn } from '../api/client.js';
import { API_DOCS } from '../shell/AppShell.js';
import { pageTitle } from '../shell/derive.js';
import { useDocumentTitle } from '../shell/useDocumentTitle.js';
import { BrandMark } from '../ui/BrandMark.js';
import { Icon } from '../ui/Icon.js';
import { ThemeSwitch } from '../ui/ThemeSwitch.js';
import { lockedText } from './passwords.js';

/** What the sign-in answer's refusal means, in words for the person signing in. */
function message(err: unknown): string {
  const {
    status,
    body,
    message: text,
  } = err as {
    status?: number;
    body?: { lockedUntil?: unknown };
    message?: string;
  };
  if (status === 401) return 'The email address or password is wrong.';
  if (status === 403 && text?.includes('expired')) {
    return 'This one-time password has expired. Ask an admin for a new one.';
  }
  if (status === 403) return 'This account is disabled. Ask an admin.';
  if (status === 429 && typeof body?.lockedUntil === 'string') return lockedText(body.lockedUntil);
  if (status === 429) return 'Too many attempts. Try again in a few minutes.';
  return `Sign-in failed: ${text ?? 'unknown error'}`;
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

/** Email and password sign-in (ADR 0013): a right password opens a session cookie. */
export function SignIn({
  api,
  ended,
  onSignedIn,
}: {
  api: Api;
  /** The previous session ended (expired, disabled or the admin password rotated). */
  ended: boolean;
  onSignedIn: (me: SignedIn) => void;
}) {
  const emailId = useId();
  const passwordId = useId();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.login(login.trim(), password));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const edit = (set: (v: string) => void) => (value: string) => {
    set(value);
    setError(null);
  };

  return (
    <AuthLayout title="Sign in">
      <form className="card auth-card" onSubmit={submit} aria-label="Sign in">
        {ended && (
          <div role="status" className="callout tone-info">
            <Icon name="clock" size={18} />
            <span>
              <strong>Your session has ended</strong>
              <span>
                It expired, an admin disabled the account, or the admin password rotated. Sign in
                again to continue.
              </span>
            </span>
          </div>
        )}
        <div className="token-field">
          <label htmlFor={emailId}>Email address</label>
          <span className={error ? 'token-input plain invalid' : 'token-input plain'}>
            <Icon name="mail" size={18} />
            <input
              id={emailId}
              type="text"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoFocus
              spellCheck={false}
              aria-invalid={error !== null}
              value={login}
              onChange={(e) => edit(setLogin)(e.target.value)}
            />
          </span>
        </div>
        <div className="token-field">
          <label htmlFor={passwordId}>Password</label>
          <span className={error ? 'token-input invalid' : 'token-input'}>
            <Icon name="key" size={18} />
            <input
              id={passwordId}
              type={shown ? 'text' : 'password'}
              autoComplete="current-password"
              spellCheck={false}
              aria-invalid={error !== null}
              value={password}
              onChange={(e) => edit(setPassword)(e.target.value)}
            />
            <button
              type="button"
              className="icon"
              aria-label={shown ? 'Hide password' : 'Show password'}
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
        <button
          type="submit"
          className="primary block"
          disabled={busy || !login.trim() || !password}
        >
          Sign in
        </button>
      </form>
      <p className="auth-hint">
        New here? An admin adds you and gives you a one-time password.
        <br />
        <span>
          Admins: sign in as <code>admin</code> with the token printed in the API log on each
          restart.
        </span>
        <br />
        <a href={API_DOCS} target="_blank" rel="noopener">
          API docs<span className="visually-hidden"> (opens in a new tab)</span>
        </a>
      </p>
    </AuthLayout>
  );
}
