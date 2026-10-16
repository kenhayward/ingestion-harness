import { ROLE_LABELS } from '@ih/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, Me, User } from '../api/client.js';
import { relativeTime } from '../jobs/derive.js';
import { FilterChips } from '../ui/FilterChips.js';
import { Icon } from '../ui/Icon.js';
import { InSlot } from '../ui/InSlot.js';
import { userCounts, userGroup, userMatches, userStatusView, type UserGroup } from './derive.js';
import { SignInsPanel } from './SignInsPanel.js';
import { UserDialog, type UserFields } from './UserDialog.js';

/** A one-time password just issued: shown once, above the list. */
interface Issued {
  name: string;
  email: string | null;
  password: string;
}

/**
 * Administration > Users (ADR 0013): the users, with Edit, Disable / Enable / Unlock, Reissue
 * one-time password and Sign-in history on each row; recent sign-ins.
 */
export function AccessPage({
  api,
  me,
  query = '',
  actions,
}: {
  api: Api;
  me: Me;
  /** Shows only matching users (name or email). */
  query?: string;
  /** Where Add user goes (the Administration dialog's header); in place without one. */
  actions?: HTMLElement | null;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [chip, setChip] = useState<'all' | UserGroup>('all');
  const [issued, setIssued] = useState<Issued | null>(null);
  const [dialog, setDialog] = useState<{ user?: User } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const isAdmin = me.role === 'admin';

  const load = useCallback(async () => {
    try {
      setUsers(await api.listUsers());
      setLoaded(true);
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
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const save = async (fields: Partial<UserFields>) => {
    const editing = dialog?.user;
    if (editing) {
      await api.updateUser(editing.id, fields);
    } else {
      const res = await api.addUser(fields as UserFields);
      setIssued({ name: res.user.name, email: res.user.email, password: res.password });
    }
    setDialog(null);
    await load();
  };

  const showHistory = (id: string | null) => {
    setHistoryOf(id);
    if (id) document.getElementById('sign-ins-heading')?.scrollIntoView?.({ block: 'start' });
  };

  const counts = userCounts(users);
  const inChip = users.filter((u) => chip === 'all' || userGroup(u) === chip);
  const shown = inChip.filter((u) => userMatches(u, query));
  const now = Date.now();
  const self = (u: User) => u.id === me.userId;

  return (
    <div className="access-page">
      <p className="muted admin-lead">
        People sign in with their email address and a password. Add each person here: they get a
        one-time password and choose their own at first sign-in.
      </p>
      <InSlot slot={actions}>
        <button type="button" className="primary" onClick={() => setDialog({})}>
          <Icon name="plus" />
          Add user
        </button>
      </InSlot>
      <aside className="note-card tone-info">
        <Icon name="key" size={18} />
        <div>
          <strong>The admin password rotates</strong>
          <p>
            Sign in as <code>admin</code> with the token the API prints in its log on every start;
            the old one stops working. Add yourself as an admin user for day-to-day use. Ten wrong
            passwords in a row lock an account for 15 minutes, longer each time after; twenty
            disable it until an admin enables it.
          </p>
        </div>
      </aside>
      {issued && (
        // Keyed per password: a second one starts uncopied (each is shown only once).
        <OneTimePassword key={issued.password} {...issued} onDone={() => setIssued(null)} />
      )}
      {error && <p role="alert">{error}</p>}
      <FilterChips
        label="Filter users by status"
        value={chip}
        onChange={setChip}
        chips={[
          { value: 'all', label: 'All', count: counts.all },
          { value: 'active', label: 'Active', count: counts.active },
          { value: 'must-change', label: 'Must change password', count: counts['must-change'] },
          { value: 'locked', label: 'Locked', count: counts.locked },
          { value: 'disabled', label: 'Disabled', count: counts.disabled },
        ]}
      />
      <div className="list-box">
        <table className="token-list" aria-label="Users">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last signed in</th>
              <th className="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && loaded && (
              <tr>
                <td colSpan={5} className="muted">
                  {inChip.length > 0 && query.trim()
                    ? `No users match “${query.trim()}”.`
                    : 'No users in this view.'}
                </td>
              </tr>
            )}
            {shown.map((u) => (
              <UserRow
                key={u.id}
                user={u}
                now={now}
                self={self(u)}
                onEdit={() => setDialog({ user: u })}
                onEnable={(enabled) => act(() => api.setUserEnabled(u.id, enabled))}
                onReissue={() =>
                  act(async () => {
                    const res = await api.reissuePassword(u.id);
                    setIssued({
                      name: res.user.name,
                      email: res.user.email,
                      password: res.password,
                    });
                  })
                }
                onHistory={() => showHistory(u.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
      {dialog && (
        <UserDialog
          user={dialog.user}
          self={dialog.user ? self(dialog.user) : false}
          onSave={save}
          onClose={() => setDialog(null)}
        />
      )}
      <SignInsPanel
        api={api}
        users={users}
        userId={historyOf}
        onUserId={showHistory}
        refreshKey={refreshKey}
      />
    </div>
  );
}

type Confirm = 'disable' | 'reissue';

function UserRow({
  user: u,
  now,
  self,
  onEdit,
  onEnable,
  onReissue,
  onHistory,
}: {
  user: User;
  now: number;
  self: boolean;
  onEdit: () => void;
  onEnable: (enabled: boolean) => Promise<void>;
  onReissue: () => Promise<void>;
  onHistory: () => void;
}) {
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirm) confirmButton.current?.focus();
  }, [confirm]);

  const status = userStatusView(u, now);
  const fromLog = u.status === 'admin-from-log';
  const disabled = u.status === 'disabled';
  const className = confirm ? 'confirming' : disabled ? 'muted-row' : undefined;
  const iconButton = (
    label: string,
    icon: Parameters<typeof Icon>[0]['name'],
    onClick: () => void,
    extra: { disabled?: boolean; title?: string; danger?: boolean } = {},
  ) => (
    <button
      type="button"
      className={extra.danger ? 'icon bordered danger' : 'icon bordered'}
      aria-label={`${label} ${u.name}`}
      title={extra.title ?? label}
      disabled={extra.disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );

  return (
    <tr className={className}>
      <td>
        <span className="token-label">{u.name}</span>
        {fromLog ? (
          <small className="muted issued-by">
            Signs in as <code>admin</code>
          </small>
        ) : (
          <small className="muted issued-by">{u.email}</small>
        )}
        {confirm && (
          <small className="confirm-text">
            {confirm === 'disable'
              ? 'Disable? They are signed out at once.'
              : 'Reissue? Their current password stops working and they are signed out.'}
          </small>
        )}
      </td>
      <td>
        <span className={`tag tone-${u.role === 'admin' ? 'info' : 'neutral'}`}>
          {ROLE_LABELS[u.role]}
        </span>
      </td>
      <td>
        <span className={`pill tone-${status.tone}`}>{status.label}</span>
        {status.detail && (
          <small
            className={u.failedSignIns > 0 && u.status !== 'disabled' ? 'expiry soon' : 'muted'}
          >
            {status.detail}
          </small>
        )}
      </td>
      <td className="muted">
        {u.lastSignInAt ? relativeTime(u.lastSignInAt, now) : 'Never signed in'}
      </td>
      <td className="actions-cell">
        {confirm ? (
          <div className="row-actions">
            <button type="button" onClick={() => setConfirm(null)}>
              Keep
            </button>
            <button
              ref={confirmButton}
              type="button"
              className="danger-fill"
              onClick={() => {
                const action = confirm === 'disable' ? () => onEnable(false) : onReissue;
                setConfirm(null);
                void action();
              }}
            >
              {confirm === 'disable' ? 'Disable now' : 'Reissue now'}
            </button>
          </div>
        ) : (
          <div className="row-actions">
            {!fromLog && iconButton('Edit', 'pencil', onEdit)}
            {!fromLog &&
              u.status === 'locked' &&
              iconButton('Unlock', 'unlock', () => void onEnable(true))}
            {!fromLog && disabled && iconButton('Enable', 'userCheck', () => void onEnable(true))}
            {!fromLog &&
              !disabled &&
              iconButton('Disable', 'userOff', () => setConfirm('disable'), {
                disabled: self,
                title: self ? 'You cannot disable yourself' : 'Disable',
                danger: true,
              })}
            {!fromLog &&
              iconButton('Reissue one-time password for', 'key', () => setConfirm('reissue'), {
                disabled: self,
                title: self
                  ? 'Change your own password from the account menu'
                  : 'Reissue one-time password',
              })}
            {iconButton('Sign-in history for', 'history', onHistory, { title: 'Sign-in history' })}
          </div>
        )}
      </td>
    </tr>
  );
}

function OneTimePassword({ name, email, password, onDone }: Issued & { onDone: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const label = `One-time password for ${name}`;
  return (
    <div className="token-panel" role="region" aria-label={label}>
      <div>
        <strong>
          {label}
          {email && <span className="muted"> ({email})</span>}
        </strong>
        <p>
          Shown once. It works for 7 days, and {name} chooses their own password at first sign-in.
        </p>
      </div>
      <div className="token-copy">
        <input
          className="mono"
          readOnly
          aria-label={label}
          value={password}
          onFocus={(e) => e.target.select()}
        />
        <button
          type="button"
          className="primary"
          onClick={() => {
            // The clipboard API needs a secure context: on plain-HTTP LAN access it doesn't exist.
            if (!navigator.clipboard) {
              setNote('Copying needs HTTPS here: select the password and copy it manually.');
              return;
            }
            navigator.clipboard.writeText(password).then(
              () => {
                setCopied(true);
                setNote('Copied.');
              },
              () => {
                setCopied(false);
                setNote('Copy failed: select the password and copy it manually.');
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
