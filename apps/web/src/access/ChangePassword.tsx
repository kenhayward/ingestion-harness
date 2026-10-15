import { useId, useState, type FormEvent } from 'react';
import type { Api, Me } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { PASSWORD_RULES, lockedText, newPasswordProblem } from './passwords.js';

function refusal(err: unknown): string {
  const { status, body, message } = err as {
    status?: number;
    body?: { lockedUntil?: unknown };
    message?: string;
  };
  if (status === 429 && typeof body?.lockedUntil === 'string') return lockedText(body.lockedUntil);
  return message ?? 'The password was not changed.';
}

/** One password input of the form, labelled and with the browser's password-manager hints. */
function Field({
  label,
  value,
  onChange,
  autoComplete,
  invalid,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  invalid: boolean;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <div className="token-field">
      <label htmlFor={id}>{label}</label>
      <span className={invalid ? 'token-input invalid' : 'token-input'}>
        <Icon name="key" size={18} />
        <input
          id={id}
          type="password"
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          spellCheck={false}
          aria-invalid={invalid}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
    </div>
  );
}

/**
 * Choose a password (ADR 0013): at first sign-in with a one-time password (`first`, the only
 * screen such a session gets), or from the account menu (`account`).
 */
export function ChangePassword({
  api,
  me,
  mode,
  onDone,
  onSignOut,
}: {
  api: Api;
  me: Me;
  mode: 'first' | 'account';
  /** The password changed (first) or the person leaves the page (account). */
  onDone: () => void;
  onSignOut: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const first = mode === 'first';

  const edit = (set: (v: string) => void) => (value: string) => {
    set(value);
    setError(null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = newPasswordProblem(next, repeat);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      if (first) onDone();
      else {
        setChanged(true);
        setCurrent('');
        setNext('');
        setRepeat('');
      }
    } catch (err) {
      setError(refusal(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card auth-card" onSubmit={submit} aria-labelledby="change-password-title">
      <h2 id="change-password-title">{first ? 'Choose your password' : 'Change your password'}</h2>
      {first && (
        <p className="muted">
          Welcome, {me.label}. You signed in with a one-time password: choose your own to continue.
        </p>
      )}
      {changed && (
        <div role="status" className="callout tone-ok">
          <Icon name="check" size={18} />
          <span>Password changed. Your other sessions are signed out.</span>
        </div>
      )}
      <Field
        label={first ? 'One-time password' : 'Current password'}
        value={current}
        onChange={edit(setCurrent)}
        autoComplete="current-password"
        invalid={error !== null}
        autoFocus
      />
      <Field
        label="New password"
        value={next}
        onChange={edit(setNext)}
        autoComplete="new-password"
        invalid={error !== null}
      />
      <Field
        label="Repeat the new password"
        value={repeat}
        onChange={edit(setRepeat)}
        autoComplete="new-password"
        invalid={error !== null}
      />
      <p className="muted small">{PASSWORD_RULES}</p>
      {error && (
        <p role="alert" className="field-error">
          <Icon name="alert" />
          {error}
        </p>
      )}
      <button
        type="submit"
        className="primary block"
        disabled={busy || !current || !next || !repeat}
      >
        {first ? 'Set password' : 'Change password'}
      </button>
      {first ? (
        <button type="button" className="block" onClick={onSignOut}>
          Sign out
        </button>
      ) : (
        <button type="button" className="block" onClick={onDone}>
          Back
        </button>
      )}
    </form>
  );
}
