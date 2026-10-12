import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AccessToken, Api, Me } from '../api/client.js';
import { relativeTime } from '../jobs/derive.js';
import { matchesQuery } from '../shell/derive.js';
import { FilterChips } from '../ui/FilterChips.js';
import { Icon } from '../ui/Icon.js';
import { Segmented } from '../ui/Segmented.js';
import { expiresSoon, expiryText, tokenCounts, tokenGroup, type TokenGroup } from './derive.js';

type Expiry = '1' | '7' | '30' | '90' | '365' | 'never';

const EXPIRY_OPTIONS: readonly { value: Expiry; label: string }[] = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];

const STATUS: Record<AccessToken['status'], { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'ok' },
  expired: { label: 'Expired', tone: 'neutral' },
  revoked: { label: 'Revoked', tone: 'danger' },
  'current-admin': { label: 'Current admin', tone: 'info' },
};

const shortDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

/** Admin page (ADR 0006, UI handoff §6): issue user tokens (shown once), revoke and delete them. */
export function AccessPage({
  api,
  me,
  query = '',
}: {
  api: Api;
  me: Me;
  /** Top-bar search: shows only matching tokens. */
  query?: string;
}) {
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState<Expiry>('30');
  const [chip, setChip] = useState<'all' | TokenGroup>('all');
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

  const counts = tokenCounts(tokens);
  const inChip = tokens.filter((t) => chip === 'all' || tokenGroup(t.status) === chip);
  const shown = inChip.filter((t) => matchesQuery(query, t.label, t.role));
  const now = Date.now();

  return (
    <div className="access-page">
      <div className="page-header">
        <div>
          <h1>Access</h1>
          <p className="muted">
            People sign in with an access token. Issue a token per person or machine; revoking one
            ends its sessions immediately.
          </p>
        </div>
      </div>
      <div className="access-top">
        <form className="card-form" onSubmit={create} aria-label="Issue a token">
          <h2>Issue a token</h2>
          <label>
            Label
            <input
              value={label}
              placeholder="e.g. Ken – laptop"
              maxLength={100}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <div className="field">
            <span className="field-label">Expires after</span>
            <Segmented
              label="Expires after"
              options={EXPIRY_OPTIONS}
              value={expiry}
              onChange={setExpiry}
            />
          </div>
          <button type="submit" className="primary" disabled={!label.trim()}>
            Create token
          </button>
        </form>
        <aside className="note-card tone-info">
          <Icon name="key" size={18} />
          <div>
            <strong>The admin token rotates</strong>
            <p>
              A new admin token is printed in the API log every time the API starts, and the old one
              stops working. Issue user tokens here for day-to-day use.
            </p>
          </div>
        </aside>
      </div>
      {created && <NewToken {...created} onDone={() => setCreated(null)} />}
      {error && <p role="alert">{error}</p>}
      <FilterChips
        label="Filter tokens by status"
        value={chip}
        onChange={setChip}
        chips={[
          { value: 'all', label: 'All', count: counts.all },
          { value: 'active', label: 'Active', count: counts.active },
          { value: 'expired', label: 'Expired', count: counts.expired },
          { value: 'revoked', label: 'Revoked', count: counts.revoked },
        ]}
      />
      <div className="list-box">
        <table className="token-list" aria-label="Access tokens">
          <thead>
            <tr>
              <th>Label</th>
              <th>Role</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Last used</th>
              <th>Status</th>
              <th className="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && tokens.length > 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  {inChip.length > 0 && query.trim()
                    ? `No tokens match “${query.trim()}”.`
                    : 'No tokens in this view.'}
                </td>
              </tr>
            )}
            {shown.map((t) => (
              <TokenRow
                key={t.id}
                token={t}
                now={now}
                onRevoke={() => act(() => api.revokeToken(t.id))}
                onDelete={() => act(() => api.deleteToken(t.id))}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TokenRow({
  token: t,
  now,
  onRevoke,
  onDelete,
}: {
  token: AccessToken;
  now: number;
  onRevoke: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<'revoke' | 'delete' | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirm) confirmButton.current?.focus();
  }, [confirm]);

  const expiry = expiryText(t, now);
  const soon = expiresSoon(t, now);
  const status = STATUS[t.status];
  const muted = t.status === 'expired' || t.status === 'revoked';
  const className = confirm ? 'confirming' : muted ? 'muted-row' : undefined;

  return (
    <tr className={className}>
      <td>
        <span className="token-label">{t.label}</span>
        {confirm && (
          <small className="confirm-text">
            {confirm === 'revoke' ? 'Revoke? Its sessions end now.' : 'Delete this token record?'}
          </small>
        )}
      </td>
      <td>
        <span className={`tag tone-${t.role === 'admin' ? 'info' : 'neutral'}`}>{t.role}</span>
      </td>
      <td className="muted">{shortDate(t.createdAt)}</td>
      <td className={soon ? 'expiry soon' : 'expiry'}>
        {expiry.date && <span>{expiry.date}</span>}
        <small>{expiry.relative}</small>
      </td>
      <td className="muted">{t.lastUsedAt ? relativeTime(t.lastUsedAt, now) : 'never used'}</td>
      <td>
        <span className={`pill tone-${status.tone}`}>{status.label}</span>
      </td>
      <td className="actions-cell">
        {t.role !== 'user' ? (
          <span className="muted">Rotates on restart</span>
        ) : confirm ? (
          <div className="row-actions">
            <button type="button" onClick={() => setConfirm(null)}>
              Keep
            </button>
            <button
              ref={confirmButton}
              type="button"
              className="danger-fill"
              onClick={() => {
                const action = confirm === 'revoke' ? onRevoke : onDelete;
                setConfirm(null);
                void action();
              }}
            >
              {confirm === 'revoke' ? 'Revoke now' : 'Delete'}
            </button>
          </div>
        ) : (
          <div className="row-actions">
            {t.status === 'active' && (
              <button type="button" onClick={() => setConfirm('revoke')}>
                Revoke
              </button>
            )}
            <button
              type="button"
              className="icon bordered danger"
              aria-label={`Delete ${t.label}`}
              title="Delete"
              onClick={() => setConfirm('delete')}
            >
              <Icon name="trash" />
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

function NewToken({ label, token, onDone }: { label: string; token: string; onDone: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="token-panel" role="region" aria-label="New token">
      <div>
        <strong>Token created for “{label}”</strong>
        <p>Copy it now — this is the only time it will be shown.</p>
      </div>
      <div className="token-copy">
        <input
          className="mono"
          readOnly
          aria-label={`New token for ${label}`}
          value={token}
          onFocus={(e) => e.target.select()}
        />
        <button
          type="button"
          className="primary"
          onClick={() => {
            // The clipboard API needs a secure context: on plain-HTTP LAN access it doesn't exist.
            if (!navigator.clipboard) {
              setNote('Copying needs HTTPS here: select the token and copy it manually.');
              return;
            }
            navigator.clipboard.writeText(token).then(
              () => {
                setCopied(true);
                setNote(null);
              },
              () => {
                setCopied(false);
                setNote('Copy failed: select the token and copy it manually.');
              },
            );
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={onDone}>
          Done
        </button>
      </div>
      {note && <p role="status">{note}</p>}
    </div>
  );
}
