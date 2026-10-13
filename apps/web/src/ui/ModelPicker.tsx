import { useEffect, useState } from 'react';
import { pickedChoice, type DataPolicy, type ModelChoice } from '@ih/shared';
import type { Api } from '../api/client.js';
import {
  CHOICES_FAILED,
  CHOICES_LOADING,
  MODEL_NOT_OFFERED,
  modelDisplayName,
} from '../jobs/derive.js';

/** A stored value no choice has: "Drafting model" for `draft`, a placeholder while unknown. */
const legacyLabel = (value: string, choices: readonly ModelChoice[]): string =>
  value === 'draft' || choices === CHOICES_LOADING || choices === CHOICES_FAILED
    ? modelDisplayName(value, choices)
    : MODEL_NOT_OFFERED;

export type ChoicesState =
  | { status: 'loading'; choices: readonly ModelChoice[] }
  | { status: 'error'; choices: readonly ModelChoice[] }
  | { status: 'ready'; choices: ModelChoice[] };

/**
 * The model choices people pick (ADR 0010, phase 4c), loaded once per `api`, with whether they
 * are `loading`, `ready` or could not be read (`error`). Until ready, `choices` is empty.
 */
export function useModelChoicesState(api: Api): ChoicesState {
  const [state, setState] = useState<ChoicesState>({
    status: 'loading',
    choices: CHOICES_LOADING,
  });
  useEffect(() => {
    let live = true;
    setState({ status: 'loading', choices: CHOICES_LOADING });
    api.listPickerChoices().then(
      (list) => live && setState({ status: 'ready', choices: list }),
      () => live && setState({ status: 'error', choices: CHOICES_FAILED }),
    );
    return () => {
      live = false;
    };
  }, [api]);
  return state;
}

/**
 * The model choices as a list. While loading, and when they cannot be read, it is the empty
 * `CHOICES_LOADING` / `CHOICES_FAILED` list: a picker offers only its empty option, and the
 * name helpers (`modelDisplayName` …) show "…" or "—" rather than "Model no longer offered".
 */
export function useModelChoices(api: Api): readonly ModelChoice[] {
  return useModelChoicesState(api).choices;
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
        {legacy && <option value={value}>{legacyLabel(value, choices)}</option>}
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
