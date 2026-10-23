import { useEffect, useState } from 'react';
import type { SinkInfo } from '@ih/shared';
import type { Api } from '../api/client.js';
import { BrowseDialog } from './BrowseDialog.js';
import { labelIn, readShape } from './browse.js';
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

/** A browsed value as shown: its label and its id in brackets, or the id alone when unnamed. */
export const shownValue = (id: string, label: string | undefined) =>
  id && label ? `${label} [${id}]` : id;

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
  /** The labels of browsed values, by field: picked here, or read from the sink for saved ones. */
  const [labels, setLabels] = useState<Record<string, { id: string; label: string }>>({});
  const browsable = (f: SinkInfo['destinationFields'][number]) =>
    f.kind === 'fixed' && f.browse && sink.capabilities.browse;
  // Browsing reads the sink as someone: a personal sink's instance, or a shared connection.
  const ready =
    sink.connectionKind === 'personal'
      ? sink.instances.length === 0 || value.instanceId !== null
      : value.connectionId !== null;
  const notReady =
    sink.connectionKind === 'personal' ? 'Choose an instance first' : 'Choose a connection first';
  const labelOf = (fieldId: string) => {
    const known = labels[fieldId];
    return known && known.id === value.destination[fieldId] ? known.label : undefined;
  };

  // A saved value is an id: name it from the sink's list, read as Browse reads it (the id alone
  // when it isn't listed, or the field is a tree).
  const unnamed = sink.destinationFields
    .filter((f) => browsable(f) && value.destination[f.id] && !labelOf(f.id))
    .map((f) => `${f.id}=${value.destination[f.id]}`)
    .join('&');
  useEffect(() => {
    if (!ready || !unnamed) return;
    let live = true;
    for (const pair of unnamed.split('&')) {
      const [fieldId, id] = pair.split('=') as [string, string];
      readShape((parentId, cursor) =>
        api.browseSink({
          sinkId: sink.id,
          instanceId: value.instanceId,
          connectionId: value.connectionId,
          field: fieldId,
          parentId,
          cursor,
        }),
      ).then(
        (shape) => {
          const label = labelIn(shape, id);
          if (live && label) setLabels((all) => ({ ...all, [fieldId]: { id, label } }));
        },
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, unnamed, sink.id, value.instanceId, value.connectionId]);
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
            {browsable(f) ? (
              <input
                className="browsed-value"
                value={shownValue(value.destination[f.id] ?? '', labelOf(f.id))}
                readOnly
                disabled={fixedLocked}
                placeholder={ready ? 'Browse to choose' : notReady}
                title={value.destination[f.id] ?? ''}
              />
            ) : (
              <input
                className="mono"
                value={value.destination[f.id] ?? ''}
                autoComplete="off"
                spellCheck={false}
                disabled={f.kind === 'fixed' && fixedLocked}
                placeholder={f.kind === 'pattern' ? '{source.stem}' : ''}
                onChange={(e) => set(f.id, e.target.value)}
              />
            )}
          </label>
          {browsable(f) && !fixedLocked && (
            <button
              type="button"
              aria-label={`Browse ${f.label}`}
              disabled={!ready}
              title={ready ? undefined : notReady}
              onClick={() => setBrowsing({ id: f.id, label: f.label })}
            >
              Browse…
            </button>
          )}
          {browsable(f) && !f.required && !fixedLocked && value.destination[f.id] && (
            <button type="button" aria-label={`Clear ${f.label}`} onClick={() => set(f.id, '')}>
              Clear
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
          onPick={(id, label) => {
            setLabels((all) => ({ ...all, [browsing.id]: { id, label } }));
            set(browsing.id, id);
          }}
          onClose={() => setBrowsing(null)}
        />
      )}
    </>
  );
}
