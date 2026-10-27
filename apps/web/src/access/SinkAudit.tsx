import { useCallback, useEffect, useState } from 'react';
import type { AuditAction, AuditEntry } from '@ih/bridge-contract';
import type { Api } from '../api/client.js';

const ACTION_LABEL: Record<AuditAction, string> = {
  instance_added: 'Instance added',
  instance_renamed: 'Instance renamed',
  instance_removed: 'Instance removed',
  client_issued: 'Client issued',
  client_revoked: 'Client revoked',
};

/** A sink's administration audit log, newest first, a page at a time (Load more). */
export function SinkAudit({ api, sinkId }: { api: Api; sinkId: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after: string | null) => {
      setBusy(true);
      try {
        const page = await api.listSinkAudit(sinkId, after);
        setEntries((before) => [...(after === null ? [] : (before ?? [])), ...page.entries]);
        setCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [api, sinkId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <section className="admin-section" aria-label="Audit log">
      <div className="admin-section-head">
        <div>
          <h3>Audit log</h3>
          <p className="muted">Every change to its instances and clients, newest first.</p>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {entries === null && !error && <p>Loading…</p>}
      {entries && entries.length === 0 && <p className="muted">No changes yet.</p>}
      {entries && entries.length > 0 && (
        <table className="token-list" aria-label="Audit log">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>Entry</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={`${e.at}-${i}`}>
                <td>{new Date(e.at).toLocaleString()}</td>
                <td>{e.actor.name}</td>
                <td>{ACTION_LABEL[e.action]}</td>
                <td className="mono">{e.subject}</td>
                <td>{e.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor && (
        <button type="button" disabled={busy} onClick={() => void load(cursor)}>
          Load more
        </button>
      )}
    </section>
  );
}
