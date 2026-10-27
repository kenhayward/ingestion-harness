import { useId, useState } from 'react';
import type { AdminInstance, InstanceField } from '@ih/bridge-contract';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';

/**
 * A sink's instances: a table (locked ones, from the sink's configuration, marked and without
 * actions), rename in place, remove after a confirmation, and Add instance, whose form is
 * rendered from the fields the sink declares (none of them a secret).
 */
export function SinkInstances({
  api,
  sinkId,
  fields,
  instances,
  error: loadError,
  onChanged,
}: {
  api: Api;
  sinkId: string;
  fields: InstanceField[];
  instances: AdminInstance[] | null;
  error: string | null;
  onChanged: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setRenaming(null);
      setRemoving(null);
      setAdding(false);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-section" aria-label="Instances">
      <div className="admin-section-head">
        <div>
          <h3>Instances</h3>
          <p className="muted">The places this system delivers to.</p>
        </div>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            Add instance
          </button>
        )}
      </div>
      {adding && (
        <AddInstanceForm
          fields={fields}
          busy={busy}
          onCancel={() => setAdding(false)}
          onAdd={(body) => void act(() => api.addSinkInstance(sinkId, body))}
        />
      )}
      {(error ?? loadError) && <p role="alert">{error ?? loadError}</p>}
      {instances === null && !loadError && <p>Loading…</p>}
      {instances && (
        <table className="token-list" aria-label="Instances">
          <thead>
            <tr>
              <th>Instance</th>
              <th>Settings</th>
              <th>Added</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {instances.map((i) => (
              <tr key={i.id}>
                <td>
                  {renaming === i.id ? (
                    <RenameForm
                      instance={i}
                      busy={busy}
                      onCancel={() => setRenaming(null)}
                      onSave={(label) =>
                        void act(() => api.renameSinkInstance(sinkId, i.id, label))
                      }
                    />
                  ) : (
                    <>
                      {i.label} <span className="mono muted">{i.id}</span>{' '}
                      {i.locked && <span className="tag tone-neutral">Locked</span>}
                    </>
                  )}
                </td>
                <td className="mono muted">
                  {Object.entries(i.fields)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')}
                </td>
                <td className="muted">
                  {i.locked
                    ? 'From its configuration'
                    : [i.createdBy?.name, i.createdAt && new Date(i.createdAt).toLocaleDateString()]
                        .filter(Boolean)
                        .join(', ')}
                </td>
                <td>
                  {!i.locked && renaming !== i.id && removing !== i.id && (
                    <div className="row-actions">
                      <button
                        type="button"
                        aria-label={`Rename ${i.label}`}
                        onClick={() => setRenaming(i.id)}
                      >
                        <Icon name="pencil" />
                        Rename
                      </button>
                      <button
                        type="button"
                        className="danger"
                        aria-label={`Remove ${i.label}`}
                        onClick={() => setRemoving(i.id)}
                      >
                        <Icon name="trash" />
                        Remove
                      </button>
                    </div>
                  )}
                  {removing === i.id && (
                    <p className="confirm-text">
                      Remove {i.label}? Targets using it fail their next delivery.{' '}
                      <button
                        type="button"
                        className="danger"
                        aria-label={`Confirm remove ${i.label}`}
                        disabled={busy}
                        onClick={() => void act(() => api.removeSinkInstance(sinkId, i.id))}
                      >
                        Remove
                      </button>{' '}
                      <button type="button" onClick={() => setRemoving(null)}>
                        Cancel
                      </button>
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RenameForm({
  instance,
  busy,
  onSave,
  onCancel,
}: {
  instance: AdminInstance;
  busy: boolean;
  onSave: (label: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(instance.label);
  return (
    <form
      className="row-actions"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (label.trim()) onSave(label.trim());
      }}
    >
      <input
        aria-label={`New label for ${instance.label}`}
        value={label}
        onChange={(ev) => setLabel(ev.target.value)}
      />
      <button type="submit" className="primary" disabled={busy || !label.trim()}>
        Save
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

function AddInstanceForm({
  fields,
  busy,
  onAdd,
  onCancel,
}: {
  fields: InstanceField[];
  busy: boolean;
  onAdd: (body: { id: string; label: string; fields: Record<string, string> }) => void;
  onCancel: () => void;
}) {
  const formId = useId();
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const filled = Object.fromEntries(
    Object.entries(values)
      .map(([k, v]) => [k, v.trim()] as const)
      .filter(([, v]) => v),
  );
  const complete =
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) &&
    label.trim() !== '' &&
    fields.every((f) => !f.required || filled[f.id]);
  return (
    <form
      aria-label="Add instance"
      className="dialog-form"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (complete) onAdd({ id, label: label.trim(), fields: filled });
      }}
    >
      <label>
        Id
        <input
          value={id}
          required
          autoComplete="off"
          className="mono"
          onChange={(ev) => setId(ev.target.value)}
        />
        <span className="muted">Lower-case letters, digits and -; it never changes.</span>
      </label>
      <label>
        Label
        <input value={label} required onChange={(ev) => setLabel(ev.target.value)} />
      </label>
      {fields.map((f) => (
        <label key={f.id}>
          {f.label}
          {!f.required && <span className="muted"> (optional)</span>}
          <input
            type="text"
            autoComplete="off"
            required={f.required}
            aria-describedby={f.hint ? `${formId}-${f.id}` : undefined}
            value={values[f.id] ?? ''}
            onChange={(ev) => setValues({ ...values, [f.id]: ev.target.value })}
          />
          {f.hint && (
            <span id={`${formId}-${f.id}`} className="muted">
              {f.hint}
            </span>
          )}
        </label>
      ))}
      <div className="row-actions">
        <button type="submit" className="primary" disabled={busy || !complete}>
          Add
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
