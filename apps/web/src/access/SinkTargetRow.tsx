import { useEffect, useId, useState } from 'react';
import { targetInUse, type PublishTargetView, type SinkInfo } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { connectionStatus } from './ConnectionPicker.js';
import { SinkTargetFields, sinkTargetComplete, type SinkTargetValue } from './SinkTargetFields.js';

const same = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * A target of an external sink: a row that opens on its fields, as its sink declares them.
 * While the target is in use its instance and fixed fields are read-only; its label, connection
 * and name patterns always change.
 */
export function SinkTargetRow({
  api,
  target: t,
  sinks,
  onChanged,
}: {
  api: Api;
  target: PublishTargetView;
  sinks: SinkInfo[];
  onChanged: () => void;
}) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(t.label);
  const [value, setValue] = useState<SinkTargetValue>({
    instanceId: t.instanceId,
    connectionId: t.connectionId,
    destination: t.destination,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    setLabel(t.label);
    setValue({
      instanceId: t.instanceId,
      connectionId: t.connectionId,
      destination: t.destination,
    });
  }, [t]);
  const sink = sinks.find((s) => s.id === t.sinkId);
  const inUse = targetInUse(t.usage);
  const dirty =
    label.trim() !== t.label ||
    value.connectionId !== t.connectionId ||
    !same(value.destination, t.destination);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(() =>
      api.updatePublishTarget(t.id, {
        ...(label.trim() !== t.label ? { label: label.trim() } : {}),
        ...(value.connectionId !== t.connectionId ? { connectionId: value.connectionId } : {}),
        ...(!same(value.destination, t.destination) ? { destination: value.destination } : {}),
      }),
    );

  return (
    <section
      className={open ? 'endpoint-row open' : 'endpoint-row'}
      aria-label={`Target ${t.label}`}
    >
      <button
        type="button"
        className="endpoint-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        <Icon name="chevronDown" />
        <span>{t.label}</span>
        <span className="mono endpoint-name">{t.id}</span>
        <span className="tag tone-neutral">{t.sinkName ?? t.sinkId}</span>
        {t.deliverOnly && <span className="tag tone-neutral">Deliver-only</span>}
        <span className="mono muted">
          {Object.entries(t.destination)
            .map(([k, v]) => `${k}: ${v}`)
            .join(' · ')}
        </span>
      </button>
      {open && (
        <form
          id={bodyId}
          className="endpoint-body dialog-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (dirty) void save();
          }}
        >
          {t.deliverOnly && (
            <p className="muted">
              What is delivered here stays here: this system can&apos;t withdraw it.
            </p>
          )}
          <label>
            Label
            <input value={label} onChange={(ev) => setLabel(ev.target.value)} />
          </label>
          {sink ? (
            <SinkTargetFields
              api={api}
              sink={sink}
              value={value}
              onChange={setValue}
              fixedLocked={inUse}
            />
          ) : (
            <p className="muted">
              {t.sinkId} is not available on the delivery bridge now: its fields can&apos;t be
              shown.
            </p>
          )}
          {t.connection && <p className="muted">Connection: {connectionStatus(t.connection)}</p>}
          {inUse && (
            <p className="muted">In use: where it delivers is locked; add a new target instead.</p>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="endpoint-actions">
            <button
              type="submit"
              className="primary"
              disabled={busy || !dirty || !sink || !sinkTargetComplete(sink, value)}
            >
              Save
            </button>
            {!confirmRemove && (
              <button
                type="button"
                className="danger"
                disabled={inUse}
                onClick={() => setConfirmRemove(true)}
              >
                <Icon name="trash" />
                Remove
              </button>
            )}
          </div>
          {confirmRemove && (
            <p className="confirm-text">
              Remove {t.label}?{' '}
              <button
                type="button"
                className="danger"
                aria-label={`Confirm remove ${t.label}`}
                disabled={busy}
                onClick={() => void act(() => api.deletePublishTarget(t.id))}
              >
                Remove
              </button>{' '}
              <button type="button" onClick={() => setConfirmRemove(false)}>
                Cancel
              </button>
            </p>
          )}
        </form>
      )}
    </section>
  );
}
