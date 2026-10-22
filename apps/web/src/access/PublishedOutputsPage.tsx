import { useCallback, useEffect, useState } from 'react';
import type { PublishTargetView, SinkInfo } from '@ih/shared';
import type { Api, Me } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { InSlot } from '../ui/InSlot.js';
import { AddTargetDialog } from './AddTargetDialog.js';
import { SinkTargetRow } from './SinkTargetRow.js';
import { TargetRow } from './TargetRow.js';

/** What a sink can do, in words. */
function capabilitiesText(s: SinkInfo): string {
  const can = [
    s.capabilities.withdraw && 'withdraw',
    s.capabilities.readBack && 'read back',
    s.capabilities.replace && 'replace',
  ].filter(Boolean);
  return s.capabilities.withdraw ? `Can ${can.join(', ')}` : 'Deliver-only';
}

/** The delivery bridge's sinks, read-only: what targets can deliver through. */
function SinksSection({ sinks }: { sinks: SinkInfo[] }) {
  return (
    <section className="admin-section" aria-label="Systems">
      <div className="admin-section-head">
        <div>
          <h3>
            Systems <span className="muted">· {sinks.length}</span>
          </h3>
          <p className="muted">The kinds of place the delivery bridge delivers to.</p>
        </div>
      </div>
      <table className="token-list" aria-label="Systems">
        <thead>
          <tr>
            <th>System</th>
            <th>Status</th>
            <th>Contract</th>
            <th>Connections</th>
            <th>What it can do</th>
          </tr>
        </thead>
        <tbody>
          {sinks.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{s.status === 'available' ? 'Available' : 'Unavailable'}</td>
              <td>{s.contractVersion}</td>
              <td>{s.connectionKind === 'personal' ? 'Personal' : 'Shared'}</td>
              <td>{capabilitiesText(s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Published outputs: the publishing targets recipes deliver to (an internal bucket on this
 * deployment's S3, or an external one). `.env` seeds `default` once; what is changed here wins.
 * Admins only.
 */
export function PublishedOutputsPage({
  api,
  me,
  actions,
}: {
  api: Api;
  me: Me;
  /** Where Add target goes (the Administration dialog's header); in place without one. */
  actions?: HTMLElement | null;
}) {
  const [targets, setTargets] = useState<PublishTargetView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [sinks, setSinks] = useState<SinkInfo[]>([]);
  const isAdmin = me.role === 'admin';

  const load = useCallback(async () => {
    try {
      setTargets(await api.listPublishTargets());
      setError(null);
      setSinks(await api.listSinks().catch(() => []));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  if (!isAdmin) return <p>Admins only.</p>;

  return (
    <div className="models-page">
      <p className="muted admin-lead">
        Where published outputs are delivered. A recipe names its publishing target on General, so
        what a recipe delivers to changes only with a new version. .env sets the default target
        once; what you change here wins. Keys for external targets are kept as connections on the
        delivery bridge: Manage connections opens its page in a new tab.
      </p>
      <InSlot slot={actions}>
        <button
          type="button"
          onClick={() => {
            setError(null);
            api.openConnections().catch((err: unknown) => setError((err as Error).message));
          }}
        >
          <Icon name="key" />
          Manage connections
        </button>
        <button type="button" className="primary" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          Add target
        </button>
      </InSlot>
      {error && <p role="alert">{error}</p>}
      {targets === null && !error && <p>Loading…</p>}
      {targets && (
        <section className="admin-section" aria-label="Targets">
          <div className="admin-section-head">
            <div>
              <h3>
                Publishing targets <span className="muted">· {targets.length}</span>
              </h3>
              <p className="muted">Open a target to change its settings or test its connection.</p>
            </div>
          </div>
          <div className="admin-list">
            {targets.map((t) =>
              t.kind === 'sink' && t.onBridge ? (
                <SinkTargetRow key={t.id} api={api} target={t} sinks={sinks} onChanged={load} />
              ) : (
                <TargetRow key={t.id} api={api} target={t} onChanged={load} />
              ),
            )}
          </div>
        </section>
      )}
      {sinks.length > 0 && <SinksSection sinks={sinks} />}
      {adding && (
        <AddTargetDialog
          api={api}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
