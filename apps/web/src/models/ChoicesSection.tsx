import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { LlmChoicesView, LlmChoiceView, LlmEndpointView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { moveFocus, usePopover } from '../ui/usePopover.js';
import { modelAt, offeredModels, optionText, type OfferedModel } from './derive.js';

type Act = (action: () => Promise<unknown>) => Promise<boolean>;

/** Offered models as `endpoint/model-id` refs, shown by name: what a choice or pipeline model may be. */
function ModelSelect({
  label,
  value,
  endpoints,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  endpoints: readonly LlmEndpointView[];
  onChange: (ref: string) => void;
  placeholder?: string;
}) {
  const offered = offeredModels(endpoints).map((m) => m.ref);
  // A stored value that is no longer offered stays visible (and selected) until changed.
  const options = value && !offered.includes(value) ? [value, ...offered] : offered;
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((ref) => (
        <option key={ref} value={ref} title={ref}>
          {optionText(ref, endpoints)}
        </option>
      ))}
    </select>
  );
}

/** The chip tile beside a choice: accent for the default. */
function Tile({ accent = false }: { accent?: boolean }) {
  return (
    <span className={accent ? 'model-tile accent' : 'model-tile'} aria-hidden="true">
      <Icon name="chip" size={18} />
    </span>
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
  endpoints,
  onChanged,
}: {
  api: Api;
  view: LlmChoicesView;
  endpoints: readonly LlmEndpointView[];
  onChanged: () => Promise<void>;
}) {
  const [picked, setPicked] = useState<OfferedModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picker = usePopover();

  const act: Act = async (action) => {
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

  return (
    <section className="admin-section" aria-label="Model choices">
      <div className="admin-section-head">
        <div>
          <h3>
            Model choices <span className="muted">· {view.choices.length}</span>
          </h3>
          <p className="muted">
            What people pick, by label, wherever a model is chosen. The default is used by recipe
            steps that name no model.
          </p>
        </div>
        <AddChoicePicker
          popover={picker}
          endpoints={endpoints}
          choices={view.choices}
          onPick={(m) => {
            picker.setOpen(false);
            setPicked(m);
          }}
        />
      </div>
      <ul className="admin-list" aria-label="Model choices">
        {picked && (
          <li className="new-choice">
            <NewChoice
              key={picked.ref}
              model={picked}
              onChangeModel={() => {
                picker.setOpen(true);
                picker.trigger.current?.focus();
              }}
              onCancel={() => setPicked(null)}
              onAdd={(label, description) =>
                act(() => api.createModelChoice({ label, description, ref: picked.ref })).then(
                  (ok) => ok && setPicked(null),
                )
              }
            />
          </li>
        )}
        {view.choices.length === 0 && !picked && (
          <li className="admin-row muted">No model choices yet: add one with Add choice.</li>
        )}
        {view.choices.map((c) => (
          <ChoiceRow
            key={c.id}
            choice={c}
            isDefault={view.settings.defaultChoice === c.id}
            endpoints={endpoints}
            act={act}
            api={api}
          />
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/** Add choice ▾: the offered models by endpoint, with a search, to start a new choice from. */
function AddChoicePicker({
  popover: p,
  endpoints,
  choices,
  onPick,
}: {
  popover: ReturnType<typeof usePopover>;
  endpoints: readonly LlmEndpointView[];
  choices: readonly LlmChoiceView[];
  onPick: (model: OfferedModel) => void;
}) {
  const [query, setQuery] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  const shown = offeredModels(endpoints).filter(
    (m) => !q || m.name.toLowerCase().includes(q) || m.modelId.toLowerCase().includes(q),
  );
  const groups = [...new Set(shown.map((m) => m.endpoint))];
  const usedBy = (ref: string) =>
    choices
      .filter((c) => c.ref === ref)
      .map((c) => c.label)
      .join(', ');

  return (
    <div className="popover-anchor" ref={p.box} onKeyDown={p.onKeyDown}>
      <button
        type="button"
        ref={p.trigger}
        className="dropdown-trigger"
        aria-haspopup="dialog"
        aria-expanded={p.open}
        onClick={() => {
          setQuery('');
          p.setOpen(!p.open);
        }}
      >
        <Icon name="plus" />
        Add choice
        <Icon name="chevronDown" />
      </button>
      {p.open && (
        <div
          className="dropdown-pop add-choice-pop"
          role="dialog"
          aria-label="Add a model choice"
          onKeyDown={(e) => moveFocus(e, list.current, '[role="option"]')}
        >
          <label className="dropdown-search">
            <Icon name="search" />
            <input
              type="search"
              aria-label="Find a model"
              placeholder="Find a model"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="dropdown-list" role="listbox" aria-label="Offered models" ref={list}>
            {shown.length === 0 && (
              <p className="muted dropdown-empty">No offered model matches.</p>
            )}
            {groups.map((g) => {
              const first = shown.find((m) => m.endpoint === g)!;
              return (
                <div key={g} role="group" aria-label={g}>
                  <div className="dropdown-group-head" aria-hidden="true">
                    <span className="mono">{g}</span> · {first.location}
                  </div>
                  {shown
                    .filter((m) => m.endpoint === g)
                    .map((m) => {
                      const used = usedBy(m.ref);
                      return (
                        <button
                          key={m.ref}
                          type="button"
                          role="option"
                          aria-selected={false}
                          className="dropdown-option"
                          onClick={() => onPick(m)}
                        >
                          <span className="option-text">
                            <span className="option-name">{m.name}</span>
                            <span className="mono option-id">{m.modelId}</span>
                          </span>
                          {used && <span className="muted option-note">Used by {used}</span>}
                          <Icon name="plus" />
                        </button>
                      );
                    })}
                </div>
              );
            })}
          </div>
          <p className="dropdown-foot muted">
            Only models an endpoint offers are listed. Offer more under Endpoints.
          </p>
        </div>
      )}
    </div>
  );
}

/** The new choice's form, first in the list: label (pre-filled with the model's name) and description. */
function NewChoice({
  model,
  onChangeModel,
  onCancel,
  onAdd,
}: {
  model: OfferedModel;
  onChangeModel: () => void;
  onCancel: () => void;
  onAdd: (label: string, description: string) => Promise<unknown>;
}) {
  const [label, setLabel] = useState(model.name);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const labelInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    labelInput.current?.focus();
    labelInput.current?.select();
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    void onAdd(label.trim(), description).finally(() => setBusy(false));
  };

  return (
    <form className="choice-form" aria-label="New model choice" onSubmit={submit}>
      <div className="choice-form-model">
        <Tile />
        <span className="choice-text">
          <strong>{model.name}</strong>
          <small className="muted">
            {model.endpoint} · <span className="mono">{model.modelId}</span>
          </small>
        </span>
        <button type="button" onClick={onChangeModel}>
          Change model
        </button>
      </div>
      <div className="choice-form-fields">
        <label>
          Label
          <input
            ref={labelInput}
            value={label}
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label>
          Description (optional)
          <input
            value={description}
            placeholder="What it's good for, shown under the label"
            maxLength={300}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </div>
      <div className="choice-form-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy || !label.trim()}>
          <Icon name="plus" />
          Add choice
        </button>
      </div>
    </form>
  );
}

function ChoiceRow({
  choice: c,
  isDefault,
  endpoints,
  act,
  api,
}: {
  choice: LlmChoiceView;
  isDefault: boolean;
  endpoints: readonly LlmEndpointView[];
  act: Act;
  api: Api;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(c.label);
  const [description, setDescription] = useState(c.description);
  const [ref, setRef] = useState(c.ref);
  const [confirm, setConfirm] = useState(false);
  const at = modelAt(c.ref, endpoints);

  if (editing) {
    return (
      <li className="new-choice" aria-label={c.label}>
        <div className="choice-form">
          <div className="choice-form-fields">
            <label>
              Label
              <input
                aria-label={`Label for ${c.id}`}
                value={label}
                maxLength={80}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <label>
              Description (optional)
              <input
                aria-label={`Description for ${c.id}`}
                value={description}
                maxLength={300}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label>
              Model
              <ModelSelect
                label={`Model for ${c.id}`}
                value={ref}
                endpoints={endpoints}
                onChange={setRef}
              />
            </label>
          </div>
          <div className="choice-form-actions">
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
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
          </div>
        </div>
      </li>
    );
  }
  return (
    <li
      className={confirm ? 'admin-row choice-row confirming' : 'admin-row choice-row'}
      aria-label={c.label}
    >
      <Tile accent={isDefault} />
      <span className="choice-text">
        <span className="choice-title">
          <strong>{c.label}</strong>
          {isDefault && <span className="tag tone-ok">Default</span>}
        </span>
        {c.description && <small className="muted ellipsis">{c.description}</small>}
        {confirm && (
          <span className="confirm-text">
            Remove this choice?{' '}
            <button
              type="button"
              className="danger"
              aria-label={`Confirm remove ${c.id}`}
              onClick={() =>
                void act(() => api.deleteModelChoice(c.id)).then(() => setConfirm(false))
              }
            >
              Remove
            </button>{' '}
            <button type="button" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </span>
        )}
      </span>
      <span className="choice-model">
        <span className="ellipsis" title={c.ref}>
          {at?.name ?? c.ref}
        </span>
        {at && (
          <small className="muted">
            {at.endpoint}
            {at.location === 'external' ? ' · external' : ''}
          </small>
        )}
      </span>
      <RowMenu
        label={c.label}
        items={[
          ...(isDefault
            ? []
            : [
                {
                  label: 'Make default',
                  icon: 'check' as const,
                  run: () => void act(() => api.setLlmSettings({ defaultChoice: c.id })),
                },
              ]),
          { label: 'Edit', icon: 'pencil' as const, run: () => setEditing(true) },
          ...(isDefault
            ? []
            : [
                {
                  label: 'Remove',
                  icon: 'trash' as const,
                  danger: true,
                  separated: true,
                  run: () => setConfirm(true),
                },
              ]),
        ]}
      />
    </li>
  );
}

interface MenuItem {
  label: string;
  icon: 'check' | 'pencil' | 'trash';
  danger?: boolean;
  /** A line above it. */
  separated?: boolean;
  run: () => void;
}

/** The `⋯` actions of one row: a menu, ↑/↓ between items, Escape closes it. */
function RowMenu({ label, items }: { label: string; items: readonly MenuItem[] }) {
  const p = usePopover();
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (p.open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [p.open]);
  const name = `Actions for ${label}`;
  return (
    <div className="popover-anchor" ref={p.box} onKeyDown={p.onKeyDown}>
      <button
        type="button"
        ref={p.trigger}
        className="icon"
        aria-label={name}
        title="Actions"
        aria-haspopup="menu"
        aria-expanded={p.open}
        onClick={() => p.setOpen(!p.open)}
      >
        <Icon name="more" size={18} strokeWidth={3} />
      </button>
      {p.open && (
        <div
          ref={menu}
          role="menu"
          aria-label={name}
          className="menu-popover row-menu"
          onKeyDown={(e) => moveFocus(e, menu.current, '[role="menuitem"]')}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={[item.danger && 'danger-item', item.separated && 'separated']
                .filter(Boolean)
                .join(' ')}
              onClick={() => {
                p.setOpen(false);
                item.run();
              }}
            >
              <Icon name={item.icon} />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The OCR, drafting and embedding models: pipeline settings, never offered as a choice. */
export function PipelineSection({
  api,
  view,
  endpoints,
  onChanged,
}: {
  api: Api;
  view: LlmChoicesView;
  endpoints: readonly LlmEndpointView[];
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const save = async (
    body: { ocrModel: string } | { draftingModel: string } | { embeddingModel: string | null },
  ) => {
    setError(null);
    try {
      await api.setLlmSettings(body);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="admin-section" aria-label="Pipeline models">
      <div className="admin-section-head">
        <div>
          <h3>Pipeline models</h3>
          <p className="muted">
            Used by the pipeline itself, never offered as a model choice: OCR transcribes image-only
            pages; drafting writes the Workbench&apos;s proposals and dev reference runs; embeddings
            rank ontology terms for the mapping stage (an OpenAI-compatible endpoint).
          </p>
        </div>
      </div>
      <div className="pipeline-fields">
        <label>
          OCR model
          <ModelSelect
            label="OCR model"
            value={view.settings.ocrModel ?? ''}
            endpoints={endpoints}
            placeholder="Not set"
            onChange={(ocrModel) => ocrModel && void save({ ocrModel })}
          />
        </label>
        <label>
          Drafting model
          <ModelSelect
            label="Drafting model"
            value={view.settings.draftingModel ?? ''}
            endpoints={endpoints}
            placeholder="Not set"
            onChange={(draftingModel) => draftingModel && void save({ draftingModel })}
          />
        </label>
        <label>
          Embedding model
          <ModelSelect
            label="Embedding model"
            value={view.settings.embeddingModel ?? ''}
            endpoints={endpoints}
            placeholder="None (lexical retrieval)"
            onChange={(ref) => void save({ embeddingModel: ref || null })}
          />
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
