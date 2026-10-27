import { useCallback, useEffect, useState } from 'react';
import type {
  AdminClient,
  AdminIssuedClient,
  ClientAccess,
  ClientExpiry,
} from '@ih/bridge-contract';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { Segmented } from '../ui/Segmented.js';
import type { InstanceChoice } from './SinkAdminDialog.js';
import { IssuedToken } from './SinkIssuedToken.js';

const ACCESS_OPTIONS = [
  { value: 'read', label: 'Read' },
  { value: 'read_write', label: 'Read and write' },
] as const;

type ExpiryValue = '7' | '30' | '90' | '365' | 'none';
const EXPIRY_OPTIONS: readonly { value: ExpiryValue; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'none', label: 'No expiry' },
];
const expiryOf = (v: ExpiryValue): ClientExpiry =>
  v === 'none' ? null : (Number(v) as Exclude<ClientExpiry, null>);

/**
 * The contract's `clientState`: the web takes only types from @ih/bridge-contract (its build is
 * not bundled here), so the three-line rule is repeated.
 */
function clientState(c: AdminClient, now: Date): 'active' | 'expired' | 'revoked' {
  if (c.revokedAt) return 'revoked';
  if (c.expiresAt && Date.parse(c.expiresAt) <= now.getTime()) return 'expired';
  return 'active';
}

const STATE_LABEL = { active: 'Active', expired: 'Expired', revoked: 'Revoked' } as const;
const STATE_TONE = { active: 'tone-ok', expired: 'tone-warn', revoked: 'tone-neutral' } as const;
const day = (at: string | null) => (at ? new Date(at).toLocaleDateString() : null);

/**
 * A sink's clients (the tokens its own callers use): a table with each one's prefix, instances,
 * access, expiry and state (locked ones, from the sink's configuration, marked and never
 * revoked), Issue client, and revoke after a confirmation. An issued token is shown once, by
 * IssuedToken, and dropped when that panel closes.
 */
export function SinkClients({
  api,
  sinkId,
  choices,
}: {
  api: Api;
  sinkId: string;
  choices: InstanceChoice[];
}) {
  const [clients, setClients] = useState<AdminClient[] | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<AdminIssuedClient | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setClients(await api.listSinkClients(sinkId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, sinkId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const label = (c: AdminClient) =>
    c.instances === 'all'
      ? 'All'
      : c.instances.map((id) => choices.find((i) => i.id === id)?.label ?? id).join(', ');
  const now = new Date();

  return (
    <section className="admin-section" aria-label="Clients">
      <div className="admin-section-head">
        <div>
          <h3>Clients</h3>
          <p className="muted">The tokens this system&apos;s own callers use.</p>
        </div>
        {!issuing && !issued && (
          <button type="button" onClick={() => setIssuing(true)}>
            <Icon name="key" />
            Issue client
          </button>
        )}
      </div>
      {issued && <IssuedToken issued={issued} onDone={() => setIssued(null)} />}
      {issuing && (
        <IssueClientForm
          choices={choices}
          busy={busy}
          onCancel={() => setIssuing(false)}
          onIssue={(body) =>
            void act(async () => {
              const answer = await api.issueSinkClient(sinkId, body);
              setIssuing(false);
              setIssued(answer);
            })
          }
        />
      )}
      {error && <p role="alert">{error}</p>}
      {clients === null && !error && <p>Loading…</p>}
      {clients && (
        <table className="token-list" aria-label="Clients">
          <thead>
            <tr>
              <th>Client</th>
              <th>Token</th>
              <th>Instances</th>
              <th>Access</th>
              <th>Expires</th>
              <th>State</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => {
              const state = clientState(c, now);
              return (
                <tr key={c.id}>
                  <td>
                    {c.name} {c.locked && <span className="tag tone-neutral">Locked</span>}
                  </td>
                  <td className="mono">{c.prefix ? `${c.prefix}…` : '—'}</td>
                  <td>{label(c)}</td>
                  <td>{c.access === 'read' ? 'Read' : 'Read and write'}</td>
                  <td>{day(c.expiresAt) ?? 'Never'}</td>
                  <td>
                    <span className={`tag ${STATE_TONE[state]}`}>{STATE_LABEL[state]}</span>
                  </td>
                  <td>
                    {!c.locked && state !== 'revoked' && revoking !== c.id && (
                      <button
                        type="button"
                        className="danger"
                        aria-label={`Revoke ${c.name}`}
                        onClick={() => setRevoking(c.id)}
                      >
                        Revoke
                      </button>
                    )}
                    {revoking === c.id && (
                      <p className="confirm-text">
                        Revoke {c.name}? Its token stops working at once.{' '}
                        <button
                          type="button"
                          className="danger"
                          aria-label={`Confirm revoke ${c.name}`}
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await api.revokeSinkClient(sinkId, c.id);
                              setRevoking(null);
                            })
                          }
                        >
                          Revoke
                        </button>{' '}
                        <button type="button" onClick={() => setRevoking(null)}>
                          Cancel
                        </button>
                      </p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function IssueClientForm({
  choices,
  busy,
  onIssue,
  onCancel,
}: {
  choices: InstanceChoice[];
  busy: boolean;
  onIssue: (body: {
    name: string;
    instances: 'all' | string[];
    access: ClientAccess;
    expiresInDays: ClientExpiry;
  }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'all' | 'chosen'>('all');
  const [chosen, setChosen] = useState<string[]>([]);
  const [access, setAccess] = useState<ClientAccess>('read');
  const [expiry, setExpiry] = useState<ExpiryValue>('90');
  const complete = name.trim() !== '' && (scope === 'all' || chosen.length > 0);
  return (
    <form
      aria-label="Issue client"
      className="dialog-form"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!complete) return;
        onIssue({
          name: name.trim(),
          instances: scope === 'all' ? 'all' : chosen,
          access,
          expiresInDays: expiryOf(expiry),
        });
      }}
    >
      <label>
        Name
        <input value={name} required autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </label>
      <fieldset>
        <legend>Instances</legend>
        <label>
          <input
            type="radio"
            name="scope"
            checked={scope === 'all'}
            onChange={() => setScope('all')}
          />
          All instances, also those added later
        </label>
        <label>
          <input
            type="radio"
            name="scope"
            checked={scope === 'chosen'}
            onChange={() => setScope('chosen')}
          />
          Chosen instances
        </label>
        {scope === 'chosen' &&
          choices.map((i) => (
            <label key={i.id}>
              <input
                type="checkbox"
                checked={chosen.includes(i.id)}
                onChange={(e) =>
                  setChosen(
                    e.target.checked ? [...chosen, i.id] : chosen.filter((id) => id !== i.id),
                  )
                }
              />
              {i.label}
            </label>
          ))}
      </fieldset>
      <div className="field">
        <span>Access</span>
        <Segmented label="Access" options={ACCESS_OPTIONS} value={access} onChange={setAccess} />
      </div>
      <div className="field">
        <span>Expires</span>
        <Segmented label="Expires" options={EXPIRY_OPTIONS} value={expiry} onChange={setExpiry} />
      </div>
      <div className="row-actions">
        <button type="submit" className="primary" disabled={busy || !complete}>
          Issue
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
