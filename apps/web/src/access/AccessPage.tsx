import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AccessToken, Api, Me } from '../api/client.js';

const EXPIRY_OPTIONS: [string, string][] = [
  ['1', '1 day'],
  ['7', '7 days'],
  ['30', '30 days'],
  ['90', '90 days'],
  ['365', '1 year'],
  ['never', 'Never'],
];

const when = (iso: string | null, empty: string) => (iso ? new Date(iso).toLocaleString() : empty);

const STATUS_LABEL: Record<AccessToken['status'], string> = {
  active: 'active',
  expired: 'expired',
  revoked: 'revoked',
  'current-admin': 'current admin',
};

/** Admin page (ADR 0006): issue user tokens (shown once), revoke and delete them. */
export function AccessPage({ api, me }: { api: Api; me: Me }) {
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState('30');
  const [created, setCreated] = useState<{ label: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = me.role === 'admin';

  const load = useCallback(async () => {
    try {
      setTokens(await api.listTokens());
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  if (!isAdmin) return <p>Admins only.</p>;

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const days = expiry === 'never' ? null : Number(expiry);
      const res = await api.createToken(label.trim(), days);
      setCreated({ label: label.trim(), token: res.token });
      setLabel('');
    });
  };

  return (
    <section className="access">
      <h2>Access</h2>
      <p>
        People sign in with an access token. The admin token changes on every restart and is printed
        in the API log; issue user tokens here.
      </p>
      <form onSubmit={create} aria-label="New token">
        <label>
          Label
          <input
            value={label}
            placeholder="e.g. Ken – laptop"
            maxLength={100}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label>
          Expires after
          <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {EXPIRY_OPTIONS.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={!label.trim()}>
          Create token
        </button>
      </form>
      {created && <NewToken {...created} onDone={() => setCreated(null)} />}
      {error && <p role="alert">{error}</p>}
      <table aria-label="Access tokens">
        <thead>
          <tr>
            <th>Label</th>
            <th>Role</th>
            <th>Created</th>
            <th>Expires</th>
            <th>Last used</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id}>
              <td>{t.label}</td>
              <td>{t.role}</td>
              <td>{when(t.createdAt, '—')}</td>
              <td>{when(t.expiresAt, 'never')}</td>
              <td>{when(t.lastUsedAt, 'never used')}</td>
              <td>
                <span className={`token-status token-${t.status}`}>{STATUS_LABEL[t.status]}</span>
              </td>
              <td>
                {t.role === 'user' && (
                  <TokenActions
                    token={t}
                    onRevoke={() => act(() => api.revokeToken(t.id))}
                    onDelete={() => act(() => api.deleteToken(t.id))}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function NewToken({ label, token, onDone }: { label: string; token: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="new-token" role="region" aria-label="New token">
      <label>
        New token for {label}
        <input readOnly value={token} onFocus={(e) => e.target.select()} />
      </label>
      <p className="hint">This is the only time it will be shown.</p>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard?.writeText(token).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <button type="button" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

function TokenActions({
  token,
  onRevoke,
  onDelete,
}: {
  token: AccessToken;
  onRevoke: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<'revoke' | 'delete' | null>(null);
  if (confirm) {
    const promptId = `confirm-token-${token.id}`;
    return (
      <>
        <span id={promptId}>
          {confirm === 'revoke'
            ? `Revoke ${token.label}? Its sessions end now.`
            : `Delete ${token.label}?`}
        </span>{' '}
        <button
          type="button"
          autoFocus
          aria-label={`Confirm ${confirm} ${token.label}`}
          aria-describedby={promptId}
          onClick={() => {
            const action = confirm === 'revoke' ? onRevoke : onDelete;
            setConfirm(null);
            void action();
          }}
        >
          Confirm
        </button>
        <button type="button" aria-label={`Keep ${token.label}`} onClick={() => setConfirm(null)}>
          Keep
        </button>
      </>
    );
  }
  return (
    <>
      {token.status === 'active' && (
        <button type="button" onClick={() => setConfirm('revoke')}>
          Revoke
        </button>
      )}
      <button type="button" className="danger" onClick={() => setConfirm('delete')}>
        Delete
      </button>
    </>
  );
}
