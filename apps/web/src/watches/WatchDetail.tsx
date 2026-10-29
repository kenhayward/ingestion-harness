import { useEffect, useState } from 'react';
import type { WatchEvent, WatchView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { relativeTime } from '../jobs/derive.js';
import { Icon } from '../ui/Icon.js';

const LEVEL_TONE = { info: 'neutral', warn: 'warn', error: 'danger' } as const;
const onOff = (v: boolean) => (v ? 'On' : 'Off');

/** A watch's settings and its newest events (what the poller did, and what it could not). */
export function WatchDetail({
  api,
  watch,
  target,
  now,
  onClose,
}: {
  api: Api;
  watch: WatchView;
  /** The target's label, when known. */
  target: string;
  now: number;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<WatchEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read again when the watch moves: a pickup, a change of state, a delivery.
  const stamp = JSON.stringify([watch.state, watch.lastPickupAt, watch.queue, watch.throughput]);
  useEffect(() => {
    let live = true;
    api.getWatch(watch.id).then(
      (d) => {
        if (!live) return;
        setEvents(d.events);
        setError(null);
      },
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [api, watch.id, stamp]);

  return (
    <aside className="batch-panel watch-detail" aria-label={watch.name}>
      <div className="watch-detail-head">
        <h2>{watch.name}</h2>
        <button type="button" className="icon" aria-label="Close details" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <dl className="batch-panel-facts">
        <dt>Folder</dt>
        <dd className="mono">{watch.sourcePath}</dd>
        <dt>Target</dt>
        <dd>{target}</dd>
        <dt>Runs as</dt>
        <dd>{watch.runAs.name ?? 'Nobody'}</dd>
        <dt>Force-load</dt>
        <dd>{onOff(watch.force)}</dd>
        <dt>Auto Approve</dt>
        <dd>{onOff(watch.autoApprove)}</dd>
        <dt>Reason files</dt>
        <dd>{onOff(watch.reasonFiles)}</dd>
        <dt>Sleep when idle</dt>
        <dd>{watch.sleepSeconds} s</dd>
        <dt>Admit at a time</dt>
        <dd>{watch.admit}</dd>
      </dl>
      <h3 className="card-label">Recent events</h3>
      {error && <p role="alert">The events could not be read: {error}</p>}
      {events === null && !error && <p className="muted">Reading the events…</p>}
      {events?.length === 0 && <p className="muted">Nothing has happened yet.</p>}
      {events && events.length > 0 && (
        <ul className="watch-events">
          {events.map((e) => (
            <li key={e.id}>
              <span className={`pill tone-${LEVEL_TONE[e.level]}`}>{e.level}</span>
              <span className="watch-event-message">{e.message}</span>
              <span className="muted" title={new Date(e.at).toLocaleString()}>
                {relativeTime(e.at, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
