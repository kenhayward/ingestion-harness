import { useEffect, useState } from 'react';
import type { MyConnection, MyConnections } from '@ih/shared';
import type { Api } from '../api/client.js';
import { HelpButton } from '../ui/Help.js';
import { Icon } from '../ui/Icon.js';

const STATUS: Record<MyConnection['status'], string> = {
  ok: 'OK',
  needs_attention: 'Needs attention',
  untested: 'Untested',
};

/** `2026-10-22 09:30`, in UTC as the bridge's page shows it. */
const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/**
 * Profile's Connections tab: the signed-in user's own logins to the systems CT Studio delivers
 * to, as the delivery bridge summarises them (never a credential). They are added and changed on
 * the bridge's connections page, which Manage connections opens in a new tab.
 */
export function ProfileConnections({ api }: { api: Api }) {
  const [mine, setMine] = useState<MyConnections | null>(null);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.listMyConnections().then(
      (m) => live && setMine(m),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const manage = async () => {
    setOpening(null);
    try {
      await api.openConnections();
    } catch (err) {
      setOpening((err as Error).message);
    }
  };

  return (
    <fieldset className="profile-connections">
      <legend>
        Your connections <HelpButton topic="connections" />
      </legend>
      <p className="muted">
        Your own logins to the systems CT Studio delivers to. Deliveries made as you use them. CT
        Studio never sees what you enter for them.
      </p>
      {failed && (
        <p role="alert" className="field-error">
          <Icon name="alert" />
          Connections are unavailable right now.
        </p>
      )}
      {mine && !mine.personalSinks && !mine.connections.length && (
        <p>No system here uses personal connections yet.</p>
      )}
      {mine && mine.personalSinks && !mine.connections.length && (
        <p>You have no connections yet.</p>
      )}
      {mine && mine.connections.length > 0 && (
        <table className="token-list" aria-label="Your connections">
          <thead>
            <tr>
              <th>Name</th>
              <th>System</th>
              <th>Instance</th>
              <th>Status</th>
              <th>Last used</th>
            </tr>
          </thead>
          <tbody>
            {mine.connections.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.sinkName}</td>
                <td>{c.instanceLabel}</td>
                <td>
                  {STATUS[c.status]}
                  {c.statusReason && <div className="muted">{c.statusReason}</div>}
                </td>
                <td>{c.lastUsedAt ? when(c.lastUsedAt) : <span className="muted">Never</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {opening && (
        <p role="alert" className="field-error">
          <Icon name="alert" />
          {opening}
        </p>
      )}
      <button type="button" onClick={() => void manage()}>
        <Icon name="open" />
        Manage connections
      </button>
    </fieldset>
  );
}
