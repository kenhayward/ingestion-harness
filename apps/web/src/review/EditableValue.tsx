import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ValueDef } from '@ih/shared';
import { Icon } from '../ui/Icon.js';
import { display } from './effective.js';

interface Props {
  def: ValueDef;
  value: unknown;
  editable: boolean;
  /** Accessible names: the Edit button and the input. */
  editLabel: string;
  inputLabel: string;
  onSave: (value: unknown) => Promise<void>;
  /** boxed: the fields grid (value in a box, pencil button); inline: compact table cells. */
  variant?: 'boxed' | 'inline';
  /** Box border: flagged (warn) or edited (info). */
  state?: 'flagged' | 'edited' | '';
  /** The value names a page: it becomes a button (named `showLabel`) that shows that page. */
  onShow?: () => void;
  showLabel?: string;
}

function toInput(def: ValueDef, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/** Text from the editor -> value sent to the API (the worker normalises by type on publish). */
function fromInput(def: ValueDef, text: string): unknown {
  const trimmed = text.trim();
  if (def.type === 'list') {
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (trimmed === '') return null;
  if (def.type === 'boolean') return trimmed === 'true';
  return trimmed;
}

export function EditableValue({
  def,
  value,
  editable,
  editLabel,
  inputLabel,
  onSave,
  variant = 'inline',
  state = '',
  onShow,
  showLabel,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  // A text value's box grows with what it holds, so a long value is read and edited whole.
  useLayoutEffect(() => {
    const box = area.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight + 2}px`;
  }, [editing, text]);

  const start = () => {
    setText(toInput(def, value));
    setEditing(true);
  };
  const save = async () => {
    setSaving(true);
    try {
      await onSave(fromInput(def, text));
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    // Enter saves; in a text box Shift+Enter starts a new line.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void save();
    }
    if (e.key === 'Escape') setEditing(false);
  };

  if (!editing && variant === 'boxed') {
    return (
      <span className="value boxed">
        <span className={`value-box ${state}`.trim()}>{display(value)}</span>
        {editable && (
          <button type="button" className="icon bordered" aria-label={editLabel} onClick={start}>
            <Icon name="pencil" />
          </button>
        )}
      </span>
    );
  }
  if (!editing) {
    return (
      <span className="value">
        {onShow ? (
          <button type="button" className="link page-link" aria-label={showLabel} onClick={onShow}>
            {display(value)}
          </button>
        ) : (
          <span>{display(value)}</span>
        )}
        {editable && (
          <button type="button" className="link" aria-label={editLabel} onClick={start}>
            Edit
          </button>
        )}
      </span>
    );
  }

  const options =
    def.type === 'enum' ? (def.enum ?? []) : def.type === 'boolean' ? ['true', 'false'] : null;
  return (
    <span className="value editing">
      {options ? (
        <select
          aria-label={inputLabel}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        >
          <option value="">—</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : def.type === 'text' ? (
        <textarea
          ref={area}
          aria-label={inputLabel}
          rows={1}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
      ) : (
        <input
          aria-label={inputLabel}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
      )}
      <button type="button" onClick={() => void save()} disabled={saving}>
        Save
      </button>
      <button type="button" className="link" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </span>
  );
}
