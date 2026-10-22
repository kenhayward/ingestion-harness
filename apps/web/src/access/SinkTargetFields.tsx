import { useState } from 'react';
import type { SinkInfo } from '@ih/shared';
import type { Api } from '../api/client.js';
import { BrowseDialog } from './BrowseDialog.js';
import { ConnectionPicker } from './ConnectionPicker.js';

/** What a target of an external sink records, as its form edits it. */
export interface SinkTargetValue {
  instanceId: string | null;
  connectionId: string | null;
  destination: Record<string, string>;
}

/** Whether every required field the sink declares has a value (and a shared sink a connection). */
export function sinkTargetComplete(sink: SinkInfo, value: SinkTargetValue): boolean {
  const filled = sink.destinationFields.every(
    (f) => !f.required || (value.destination[f.id] ?? '').trim() !== '',
  );
  const placed =
    sink.connectionKind === 'personal'
      ? sink.instances.length === 0 || value.instanceId !== null
      : value.connectionId !== null;
  return filled && placed;
}

/**
 * A target's fields as its sink declares them: the instance (a personal sink) or the shared
 * connection, then each destination field. A fixed field names a place in the sink and locks
 * while the target is in use; a pattern field is resolved for each document (for example
 * `{source.stem}` or `{field:title|source.stem}`) and never locks.
 */
export function SinkTargetFields({
  api,
  sink,
  value,
  onChange,
  fixedLocked = false,
  instanceFixed = false,
}: {
  api: Api;
  sink: SinkInfo;
  value: SinkTargetValue;
  onChange: (next: SinkTargetValue) => void;
  /** The target is in use: its instance and fixed fields can't change. */
  fixedLocked?: boolean;
  /** A saved target: its instance never changes (add a new target instead). */
  instanceFixed?: boolean;
}) {
  const set = (id: string, v: string) =>
    onChange({ ...value, destination: { ...value.destination, [id]: v } });
  const [browsing, setBrowsing] = useState<{ id: string; label: string } | null>(null);
  return (
    <>
      {sink.connectionKind === 'personal' ? (
        sink.instances.length > 0 && (
          <label>
            Instance
            <select
              value={value.instanceId ?? ''}
              disabled={fixedLocked || instanceFixed}
              onChange={(e) => onChange({ ...value, instanceId: e.target.value || null })}
            >
              <option value="">Choose an instance</option>
              {sink.instances.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>
        )
      ) : (
        <ConnectionPicker
          api={api}
          sinkId={sink.id}
          value={value.connectionId ?? ''}
          onChange={(id) => onChange({ ...value, connectionId: id || null })}
        />
      )}
      {sink.connectionKind === 'personal' && (
        <p className="muted">
          Deliveries use the connection of the person who approved (or uploaded) the document.
        </p>
      )}
      {sink.destinationFields.map((f) => (
        <div className="target-field" key={f.id}>
          <label>
            {f.label}
            {f.required ? '' : ' (optional)'}
            <input
              className="mono"
              value={value.destination[f.id] ?? ''}
              autoComplete="off"
              spellCheck={false}
              disabled={f.kind === 'fixed' && fixedLocked}
              placeholder={f.kind === 'pattern' ? '{source.stem}' : ''}
              onChange={(e) => set(f.id, e.target.value)}
            />
          </label>
          {f.kind === 'fixed' && f.browse && sink.capabilities.browse && !fixedLocked && (
            <button
              type="button"
              aria-label={`Browse ${f.label}`}
              onClick={() => setBrowsing({ id: f.id, label: f.label })}
            >
              Browse…
            </button>
          )}
          {f.kind === 'pattern' && (
            <small className="muted">
              A name pattern, resolved for each document
              {f.overridable ? '; a reviewer can change it' : ''}.
            </small>
          )}
        </div>
      ))}
      {browsing && (
        <BrowseDialog
          api={api}
          sinkId={sink.id}
          instanceId={value.instanceId}
          connectionId={value.connectionId}
          field={browsing.id}
          label={browsing.label}
          onPick={(id) => set(browsing.id, id)}
          onClose={() => setBrowsing(null)}
        />
      )}
    </>
  );
}
