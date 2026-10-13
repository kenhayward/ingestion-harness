import { useState, type FormEvent } from 'react';
import type { LlmChoicesView, LlmChoiceView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';

/** Offered models as `endpoint/model-id` refs: what a choice or a pipeline model may point at. */
function ModelSelect({
  label,
  value,
  offered,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  offered: readonly string[];
  onChange: (ref: string) => void;
  placeholder?: string;
}) {
  // A stored value that is no longer offered stays visible (and selected) until changed.
  const options = value && !offered.includes(value) ? [value, ...offered] : offered;
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((ref) => (
        <option key={ref} value={ref}>
          {ref}
        </option>
      ))}
    </select>
  );
}

/**
 * Model choices (ADR 0010, phase 4b): the labelled models people pick everywhere. One is the
 * default, used by template steps that name none. Templates and jobs store a choice's id, so a
 * rename changes nothing they do.
 */
export function ChoicesSection({
  api,
  view,
  offered,
  onChanged,
}: {
  api: Api;
  view: LlmChoicesView;
  offered: readonly string[];
  onChanged: () => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [ref, setRef] = useState('');
  const [error, setError] = useState<string | null>(null);

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await onChanged();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void act(() => api.createModelChoice({ label: label.trim(), description, ref })).then((ok) => {
      if (!ok) return;
      setLabel('');
      setDescription('');
      setRef('');
    });
  };

  return (
    <section className="choices-section" aria-label="Model choices">
      <h2>Model choices</h2>
      <p className="muted">
        What people pick, by label, wherever a model is chosen. The default is used by recipe steps
        that name no model.
      </p>
      <div className="list-box">
        <table className="choice-list" aria-label="Model choices">
          <thead>
            <tr>
              <th>Label</th>
              <th>Model</th>
              <th className="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {view.choices.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  No model choices yet: add one below.
                </td>
              </tr>
            )}
            {view.choices.map((c) => (
              <ChoiceRow
                key={c.id}
                choice={c}
                isDefault={view.settings.defaultChoice === c.id}
                offered={offered}
                act={act}
                api={api}
              />
            ))}
          </tbody>
        </table>
      </div>
      <form className="card-form" aria-label="Add a model choice" onSubmit={add}>
        <label>
          Label
          <input
            value={label}
            placeholder="e.g. Main Production Model"
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label>
          Description
          <input
            value={description}
            placeholder="e.g. New for testing only"
            maxLength={300}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label>
          Model
          <ModelSelect
            label="Model"
            value={ref}
            offered={offered}
            onChange={setRef}
            placeholder="Choose a model…"
          />
        </label>
        <button type="submit" className="primary" disabled={!label.trim() || !ref}>
          <Icon name="plus" />
          Add choice
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function ChoiceRow({
  choice: c,
  isDefault,
  offered,
  act,
  api,
}: {
  choice: LlmChoiceView;
  isDefault: boolean;
  offered: readonly string[];
  act: (action: () => Promise<unknown>) => Promise<boolean>;
  api: Api;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(c.label);
  const [description, setDescription] = useState(c.description);
  const [ref, setRef] = useState(c.ref);
  const [confirm, setConfirm] = useState(false);

  if (editing) {
    return (
      <tr>
        <td>
          <input
            aria-label={`Label for ${c.id}`}
            value={label}
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            aria-label={`Description for ${c.id}`}
            value={description}
            maxLength={300}
            onChange={(e) => setDescription(e.target.value)}
          />
        </td>
        <td>
          <ModelSelect
            label={`Model for ${c.id}`}
            value={ref}
            offered={offered}
            onChange={setRef}
          />
        </td>
        <td className="actions-cell">
          <button
            type="button"
            className="primary"
            aria-label={`Save ${c.id}`}
            disabled={!label.trim()}
            onClick={() =>
              void act(() =>
                api.updateModelChoice(c.id, { label: label.trim(), description, ref }),
              ).then((ok) => ok && setEditing(false))
            }
          >
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </td>
      </tr>
    );
  }
  return (
    <tr className={confirm ? 'confirming' : undefined}>
      <td>
        <span className="choice-label">{c.label}</span>{' '}
        {isDefault && <span className="tag tone-info">Default</span>}
        {c.description && <small className="muted choice-description">{c.description}</small>}
        {confirm && <small className="confirm-text">Remove this choice?</small>}
      </td>
      <td>
        <code>{c.ref}</code>
      </td>
      <td className="actions-cell">
        {confirm ? (
          <>
            <button
              type="button"
              className="danger"
              aria-label={`Confirm remove ${c.id}`}
              onClick={() =>
                void act(() => api.deleteModelChoice(c.id)).then(() => setConfirm(false))
              }
            >
              Remove
            </button>
            <button type="button" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </>
        ) : (
          <>
            {!isDefault && (
              <button
                type="button"
                onClick={() => void act(() => api.setLlmSettings({ defaultChoice: c.id }))}
              >
                Make default
              </button>
            )}
            <button
              type="button"
              className="icon"
              aria-label={`Edit ${c.label}`}
              title="Edit"
              onClick={() => setEditing(true)}
            >
              <Icon name="pencil" />
            </button>
            {!isDefault && (
              <button
                type="button"
                className="icon"
                aria-label={`Remove ${c.label}`}
                title="Remove"
                onClick={() => setConfirm(true)}
              >
                <Icon name="trash" />
              </button>
            )}
          </>
        )}
      </td>
    </tr>
  );
}

/** The OCR and drafting models: pipeline settings, never offered as a choice. */
export function PipelineSection({
  api,
  view,
  offered,
  onChanged,
}: {
  api: Api;
  view: LlmChoicesView;
  offered: readonly string[];
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const save = async (body: { ocrModel: string } | { draftingModel: string }) => {
    setError(null);
    try {
      await api.setLlmSettings(body);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="pipeline-section" aria-label="Pipeline models">
      <h2>Pipeline models</h2>
      <p className="muted">
        Used by the pipeline itself, never offered as a model choice: OCR transcribes image-only
        pages; drafting writes the Workbench&apos;s proposals and dev reference runs.
      </p>
      <div className="pipeline-fields">
        <label>
          OCR model
          <ModelSelect
            label="OCR model"
            value={view.settings.ocrModel ?? ''}
            offered={offered}
            placeholder="Not set"
            onChange={(ocrModel) => ocrModel && void save({ ocrModel })}
          />
        </label>
        <label>
          Drafting model
          <ModelSelect
            label="Drafting model"
            value={view.settings.draftingModel ?? ''}
            offered={offered}
            placeholder="Not set"
            onChange={(draftingModel) => draftingModel && void save({ draftingModel })}
          />
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
