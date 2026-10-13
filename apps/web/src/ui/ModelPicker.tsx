import { useEffect, useState } from 'react';
import { pickedChoice, type DataPolicy, type ModelChoice } from '@ih/shared';
import type { Api } from '../api/client.js';
import { modelDisplayName } from '../jobs/derive.js';

/**
 * The model choices people pick (ADR 0010, phase 4c), loaded once per `api`; empty while
 * loading or when they cannot be read (a picker then offers only its empty option).
 */
export function useModelChoices(api: Api): ModelChoice[] {
  const [choices, setChoices] = useState<ModelChoice[]>([]);
  useEffect(() => {
    let live = true;
    api.listPickerChoices().then(
      (list) => live && setChoices(list),
      () => live && setChoices([]),
    );
    return () => {
      live = false;
    };
  }, [api]);
  return choices;
}

/**
 * The one model picker: model choices by label (the default marked, external ones flagged),
 * with an External tag below an external pick. A local-only project cannot pick an external
 * choice. `value` is a choice id (`default` reads as the default choice) or '' for
 * `emptyLabel`; a stored name that is no choice (a legacy ref) shows as "Model no longer offered".
 */
export function ModelPicker({
  label,
  choices,
  value,
  onChange,
  emptyLabel,
  dataPolicy,
  disabled,
  title,
  selectRef,
}: {
  /** The accessible name. */
  label: string;
  choices: readonly ModelChoice[];
  value: string;
  onChange: (id: string) => void;
  /** The option for "no override" (value ''); absent: a choice must be picked. */
  emptyLabel?: string;
  dataPolicy?: DataPolicy;
  disabled?: boolean;
  /** Why it is disabled, say (the select's tooltip). */
  title?: string;
  /** The select element (e.g. to focus it when an inline confirm opens). */
  selectRef?: (el: HTMLSelectElement | null) => void;
}) {
  const picked = value ? pickedChoice(value, choices) : null;
  const selected = picked?.id ?? value;
  const legacy = value !== '' && picked === null;
  return (
    <span className="model-picker">
      <select
        ref={selectRef}
        aria-label={label}
        value={selected}
        disabled={disabled}
        title={title}
        onChange={(e) => onChange(e.target.value)}
      >
        {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
        {legacy && <option value={value}>Model no longer offered</option>}
        {choices.map((c) => (
          <option
            key={c.id}
            value={c.id}
            title={c.description || undefined}
            disabled={dataPolicy === 'local' && c.location === 'external'}
          >
            {c.label}
            {c.isDefault ? ' (default)' : ''}
            {c.location === 'external' ? ' · external' : ''}
          </option>
        ))}
      </select>
      {picked?.location === 'external' && (
        <small className="model-hint muted">
          <span className="tag tone-warn">External</span>
        </small>
      )}
    </span>
  );
}

/**
 * The "no override" option: run each step with its own model, else the document type's model,
 * else the default choice. Names the choice when the type is known (`{ model? }` from its
 * definition or spec summary).
 */
export function typeModelLabel(
  choices: readonly ModelChoice[],
  type: { model?: string } | undefined,
): string {
  const base = "Document type's model";
  if (!type) return base;
  const name = type.model
    ? modelDisplayName(type.model, choices)
    : choices.find((c) => c.isDefault)?.label;
  return name ? `${base} (${name})` : base;
}
