import { useState, type FormEvent } from 'react';
import type { Api, Me } from '../api/client.js';

function message(err: unknown): string {
  const status = (err as { status?: number }).status;
  if (status === 401) return 'That token is invalid or has expired.';
  if (status === 429) return 'Too many attempts. Try again in a few minutes.';
  return `Sign-in failed: ${(err as Error).message}`;
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
  const [token, setToken] = useState('');
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
    <main className="sign-in">
      <h1>Ingestion Harness</h1>
      {ended && <p role="status">Your session has ended.</p>}
      <form onSubmit={submit} aria-label="Sign in">
        <label>
          Access token
          <input
            type="password"
            autoComplete="off"
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || !token.trim()}>
          Sign in
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      <p className="hint">Ask an administrator for an access token.</p>
    </main>
  );
}
