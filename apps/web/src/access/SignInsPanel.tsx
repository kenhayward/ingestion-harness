import { useEffect, useState } from 'react';
import type { Api, SignInEvent, User } from '../api/client.js';
import { relativeTime } from '../jobs/derive.js';
import { Icon } from '../ui/Icon.js';
import { deviceName, signInResultView } from './derive.js';

const FIRST = 50;
const MORE = 200;

/**
 * Recent sign-ins (ADR 0013, D11): sign-in attempts and password changes, newest first, for
 * everyone or one user. `refreshKey` changes when the page did something worth re-reading.
 */
export function SignInsPanel({
  api,
  users,
  userId,
  onUserId,
  refreshKey,
}: {
  api: Api;
  users: User[];
  userId: string | null;
  onUserId: (id: string | null) => void;
  refreshKey: number;
}) {
  const [events, setEvents] = useState<SignInEvent[] | null>(null);
  const [limit, setLimit] = useState(FIRST);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    api.listSignIns(userId ? { userId, limit } : { limit }).then(
      (list) => live && setEvents(list),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [api, userId, limit, refreshKey, tick]);

  const now = Date.now();
  return (
    <section className="sign-ins" aria-labelledby="sign-ins-heading">
      <div className="section-head">
        <div>
          <h2 id="sign-ins-heading">Recent sign-ins</h2>
          <p className="muted">Kept for 90 days.</p>
        </div>
        <div className="row-actions">
          <label className="inline-field">
            <span className="visually-hidden">Whose sign-ins</span>
            <select
              aria-label="Whose sign-ins"
              value={userId ?? ''}
              onChange={(e) => onUserId(e.target.value || null)}
            >
              <option value="">Everyone</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          {userId && (
            <button type="button" className="chip" onClick={() => onUserId(null)}>
              Clear
            </button>
          )}
          <button type="button" onClick={() => setTick((t) => t + 1)}>
            <Icon name="history" />
            Refresh
          </button>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {events && events.length === 0 && !error && <p className="muted">No sign-ins yet.</p>}
      {events && events.length > 0 && (
        <div className="list-box">
          <table className="token-list" aria-label="Recent sign-ins">
            <thead>
              <tr>
                <th>When</th>
                <th>User</th>
                <th>Result</th>
                <th>IP address</th>
                <th>Device</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const result = signInResultView(e, now);
                return (
                  <tr key={e.id}>
                    <td className="muted" title={new Date(e.at).toLocaleString()}>
                      {relativeTime(e.at, now)}
                    </td>
                    <td>{e.name ?? <span className="muted">Unknown email</span>}</td>
                    <td>
                      <span className={`pill tone-${result.tone}`}>{result.label}</span>
                    </td>
                    <td className="mono">{e.ip}</td>
                    <td className="muted" title={e.userAgent ?? undefined}>
                      {deviceName(e.userAgent)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {events && events.length >= FIRST && limit === FIRST && (
        <button type="button" onClick={() => setLimit(MORE)}>
          Show more
        </button>
      )}
    </section>
  );
}
