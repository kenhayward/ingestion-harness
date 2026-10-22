import { useEffect, useState } from 'react';
import type { TargetConnection } from '@ih/shared';
import type { Api } from '../api/client.js';

const STATUS: Record<TargetConnection['status'], string> = {
  ok: 'OK',
  needs_attention: 'Needs attention',
  untested: 'Untested',
};

/** A connection's status in words, with the bridge's reason when it needs attention. */
export function connectionStatus(c: TargetConnection): string {
  return c.statusReason ? `${STATUS[c.status]}: ${c.statusReason}` : STATUS[c.status];
}

/**
 * The delivery bridge's shared connections an external target may use. Credentials never pass
 * through CT Studio: they are added and rotated on the bridge's connections page.
 */
export function ConnectionPicker({
  api,
  value,
  current,
  sinkId,
  onChange,
}: {
  api: Api;
  value: string;
  /** Whose shared connections are offered (default: S3's). */
  sinkId?: string;
  /** The target's connection as last seen, shown even before (or without) the list. */
  current?: TargetConnection | null;
  onChange: (id: string) => void;
}) {
  const [connections, setConnections] = useState<TargetConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .listSharedConnections(sinkId)
      .then((list) => live && setConnections(list))
      .catch((err: unknown) => live && setError((err as Error).message));
    return () => {
      live = false;
    };
  }, [api, sinkId]);

  const listed = connections ?? [];
  const options =
    current && !listed.some((c) => c.id === current.id) ? [current, ...listed] : listed;
  const empty = connections !== null && options.length === 0;

  return (
    <div className="target-field">
      <label>
        Connection
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{empty ? 'No connections' : 'Choose a connection'}</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {`${c.name} (${STATUS[c.status]})`}
            </option>
          ))}
        </select>
      </label>
      {empty && (
        <small className="muted">
          No connections yet: add one under Manage connections, then come back.
        </small>
      )}
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
