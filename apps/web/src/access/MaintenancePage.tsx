import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  MAINTENANCE_MESSAGE_MAX,
  DEFAULT_MAINTENANCE_MESSAGE,
  type MaintenanceView,
} from '@ih/shared';
import type { Api, Me } from '../api/client.js';
import { MaintenanceBanner } from './MaintenanceBanner.js';

const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * Administration > Maintenance (migration 0046): take CT Studio down for everyone but admins
 * while models are swapped or a deploy runs, with a message the sign-in page shows. Users keep
 * their sessions and carry on once it is off; queued jobs keep running.
 */
export function MaintenancePage({
  api,
  me,
  onChanged,
}: {
  api: Api;
  me: Me;
  /** Saved: the app's own strip follows. */
  onChanged?: (view: MaintenanceView) => void;
}) {
  const isAdmin = me.role === 'admin';
  const messageId = useId();
  const previewId = useId();
  const [view, setView] = useState<MaintenanceView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const show = (next: MaintenanceView) => {
    setView(next);
    setEnabled(next.enabled);
    setMessage(next.message);
  };

  useEffect(() => {
    if (!isAdmin) return;
    api.getMaintenance().then(show, (err: unknown) => setError((err as Error).message));
  }, [api, isAdmin]);

  if (!isAdmin) return <p>Admins only.</p>;

  const changed = !!view && (enabled !== view.enabled || message.trim() !== view.message);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const next = await api.setMaintenance({ enabled, message: message.trim() });
      show(next);
      onChanged?.(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="maintenance-page">
      <p className="muted admin-lead">
        While CT Studio is under maintenance only admins can sign in and use it: everyone else sees
        the message below, on the sign-in page and in the app. They stay signed in and carry on once
        it is off. Queued jobs keep running.
      </p>
      {error && <p role="alert">{error}</p>}
      {view && (
        <form className="maintenance-form" onSubmit={submit}>
          <div className="maintenance-field">
            <label className="inline maintenance-switch">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Under maintenance
            </label>
            <p className="muted maintenance-state">
              {view.enabled && view.since ? `On since ${when(view.since)}` : 'Off'}
              {view.updatedBy && view.updatedAt
                ? ` · changed by ${view.updatedBy}, ${when(view.updatedAt)}`
                : ''}
            </p>
          </div>
          <div className="maintenance-field">
            <label htmlFor={messageId}>Message to users</label>
            <textarea
              id={messageId}
              rows={4}
              maxLength={MAINTENANCE_MESSAGE_MAX}
              placeholder={DEFAULT_MAINTENANCE_MESSAGE}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <small className="muted">
              Blank: “{DEFAULT_MAINTENANCE_MESSAGE}” Kept when maintenance is switched off.
            </small>
          </div>
          <section aria-labelledby={previewId} className="maintenance-preview">
            <h3 id={previewId}>What users see</h3>
            <MaintenanceBanner
              live={false}
              notice={{
                enabled: true,
                message,
                since: view.enabled ? view.since : null,
              }}
            >
              Only admins can sign in until it is over.
            </MaintenanceBanner>
          </section>
          <div>
            <button type="submit" className="primary" disabled={!changed || saving}>
              Save
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
