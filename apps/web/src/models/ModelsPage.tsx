import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  type EndpointPatchBody,
  type LlmChoicesView,
  type LlmEndpointView,
  type LlmModelView,
  type ProviderKind,
} from '@ih/shared';
import type { Api, Me } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { Icon } from '../ui/Icon.js';
import { InSlot } from '../ui/InSlot.js';
import { Segmented } from '../ui/Segmented.js';
import { moveFocus, usePopover } from '../ui/usePopover.js';
import { ChoicesSection, PipelineSection } from './ChoicesSection.js';
import { modelName, sourceText } from './derive.js';

type Location = LlmEndpointView['location'];

const LOCATIONS: readonly { value: Location; label: string }[] = [
  { value: 'local', label: 'Local' },
  { value: 'external', label: 'External' },
];
const KIND_LABEL: Record<ProviderKind, string> = {
  'openai-chat': 'OpenAI-compatible (chat)',
  'openai-responses': 'OpenAI (responses)',
  anthropic: 'Anthropic',
};

function keyText(e: LlmEndpointView): string {
  if (e.keySet) return 'Key stored (encrypted)';
  if (e.apiKeyEnv) return `Key from .env (${e.apiKeyEnv})`;
  return 'No key';
}

/**
 * Models (ADR 0010): the labelled model choices people pick, the pipeline's OCR and drafting
 * models, and the LLM endpoints with the models each one offers. .env seeds them; changes made
 * here win. Admins only.
 */
export function ModelsPage({
  api,
  me,
  actions,
}: {
  api: Api;
  me: Me;
  /** Where Add endpoint goes (the Administration dialog's header); in place without one. */
  actions?: HTMLElement | null;
}) {
  const [endpoints, setEndpoints] = useState<LlmEndpointView[] | null>(null);
  const [choices, setChoices] = useState<LlmChoicesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const isAdmin = me.role === 'admin';

  const load = useCallback(async () => {
    try {
      const [nextEndpoints, nextChoices] = await Promise.all([
        api.listLlmEndpoints(),
        api.listModelChoices(),
      ]);
      setEndpoints(nextEndpoints);
      setChoices(nextChoices);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  if (!isAdmin) return <p>Admins only.</p>;

  return (
    <div className="models-page">
      <p className="muted admin-lead">
        The model choices people pick, the pipeline&apos;s own models, and the endpoints the worker
        sends requests to with the models each one offers. .env sets the defaults; what you change
        here wins and reaches the workers within seconds.
      </p>
      <InSlot slot={actions}>
        <button type="button" className="primary" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          Add endpoint
        </button>
      </InSlot>
      {error && <p role="alert">{error}</p>}
      {endpoints === null && !error && <p>Loading…</p>}
      {endpoints && choices && (
        <>
          <ChoicesSection api={api} view={choices} endpoints={endpoints} onChanged={load} />
          <PipelineSection api={api} view={choices} endpoints={endpoints} onChanged={load} />
        </>
      )}
      {endpoints && (
        <section className="admin-section" aria-label="Endpoints">
          <div className="admin-section-head">
            <div>
              <h3>
                Endpoints <span className="muted">· {endpoints.length}</span>
              </h3>
              <p className="muted">
                Where the worker sends requests. Open one to change its connection or the models it
                offers.
              </p>
            </div>
          </div>
          {endpoints.length === 0 ? (
            <p className="muted">No endpoints yet.</p>
          ) : (
            <div className="admin-list">
              {endpoints.map((e) => (
                <EndpointRow key={e.name} api={api} endpoint={e} onChanged={load} />
              ))}
            </div>
          )}
        </section>
      )}
      {adding && (
        <AddEndpoint
          api={api}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

/** What the limit box holds: empty (the default) or a whole number of tokens in range. */
function limitProblem(text: string): string | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= MIN_OUTPUT_TOKENS && n <= MAX_OUTPUT_TOKENS
    ? null
    : `Between ${MIN_OUTPUT_TOKENS.toLocaleString('en-GB')} and ${MAX_OUTPUT_TOKENS.toLocaleString('en-GB')} tokens, or empty for the default`;
}

/**
 * An offered model's output limit: the most tokens one reply may use where the step does not
 * say (Workbench drafting and mapping). Empty is the default. Set shows once it changed.
 */
function OutputLimit({
  model,
  disabled,
  onSave,
}: {
  model: LlmModelView;
  disabled: boolean;
  onSave: (maxOutputTokens: number | null) => void;
}) {
  const stored = model.maxOutputTokens === null ? '' : String(model.maxOutputTokens);
  const [text, setText] = useState(stored);
  useEffect(() => setText(stored), [stored]);
  const problem = limitProblem(text);
  const changed = text.trim() !== stored;
  const save = () => {
    if (problem || !changed) return;
    onSave(text.trim() === '' ? null : Number(text));
  };
  const fallback = DEFAULT_MAX_OUTPUT_TOKENS.toLocaleString('en-GB');
  return (
    <span className="output-limit">
      <span className="muted" aria-hidden="true">
        Max output
      </span>
      <input
        type="number"
        inputMode="numeric"
        min={MIN_OUTPUT_TOKENS}
        max={MAX_OUTPUT_TOKENS}
        step={1024}
        aria-label={`Max output tokens for ${model.modelId}`}
        title={`Empty: the default, ${fallback} tokens`}
        placeholder={fallback}
        value={text}
        disabled={disabled}
        onChange={(ev) => setText(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            save();
          }
        }}
      />
      <span className="muted" aria-hidden="true">
        tokens
      </span>
      {changed && (
        <button
          type="button"
          aria-label={`Set the output limit of ${model.modelId}`}
          disabled={disabled || problem !== null}
          title={problem ?? undefined}
          onClick={save}
        >
          Set
        </button>
      )}
    </span>
  );
}

/**
 * One endpoint: a row that opens on its connection (base URL, location, key, discover, enable,
 * remove) and the models it offers. Offering a model or stopping saves the list at once.
 */
function EndpointRow({
  api,
  endpoint: e,
  onChanged,
}: {
  api: Api;
  endpoint: LlmEndpointView;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const bodyId = useId();
  const offered = e.models.filter((m) => m.curated);

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
      await onChanged();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const update = (patch: EndpointPatchBody) => act(() => api.updateLlmEndpoint(e.name, patch));
  /** Saves exactly these model ids as offered. */
  const offer = (ids: readonly string[]) =>
    act(() => api.setLlmEndpointModels(e.name, [...new Set(ids)].sort()));
  const ids = offered.map((m) => m.modelId);

  return (
    <section
      className={open ? 'endpoint-row open' : 'endpoint-row'}
      aria-label={`Endpoint ${e.name}`}
    >
      <button
        type="button"
        className="endpoint-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        <Icon name="chevronDown" />
        <span className="mono endpoint-name">{e.name}</span>
        <span className="tag tone-neutral">{KIND_LABEL[e.kind]}</span>
        <span className="muted endpoint-where">
          {e.location === 'local' ? 'Local' : 'External'} · {sourceText(e)}
        </span>
        <span className="endpoint-count">
          {offered.length} of {e.models.length} offered
        </span>
        <span className={`tag tone-${e.enabled ? 'ok' : 'neutral'}`}>
          {e.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </button>
      {open && (
        <div id={bodyId} className="endpoint-body">
          <div className="endpoint-connection">
            <span className="small-caps">Connection</span>
            <dl className="endpoint-meta">
              <dt>Base URL</dt>
              <dd>
                {url === null ? (
                  <>
                    <code>{e.baseUrl ?? 'provider default'}</code>
                    <button
                      type="button"
                      className="icon"
                      aria-label="Edit base URL"
                      title="Edit base URL"
                      onClick={() => setUrl(e.baseUrl ?? '')}
                    >
                      <Icon name="pencil" />
                    </button>
                  </>
                ) : (
                  <span className="inline-edit">
                    <input
                      aria-label="Base URL"
                      value={url}
                      placeholder="http://host:8000/v1"
                      onChange={(ev) => setUrl(ev.target.value)}
                    />
                    <button
                      type="button"
                      className="primary"
                      aria-label="Save base URL"
                      onClick={() =>
                        void update({ baseUrl: url.trim() || null }).then(
                          (ok) => ok && setUrl(null),
                        )
                      }
                    >
                      Save
                    </button>
                    <button type="button" onClick={() => setUrl(null)}>
                      Cancel
                    </button>
                  </span>
                )}
              </dd>
              <dt>Location</dt>
              <dd>
                <Segmented
                  label="Location"
                  options={LOCATIONS}
                  value={e.location}
                  onChange={(location) => {
                    if (location !== e.location) void update({ location });
                  }}
                />
                <small className="muted">
                  {e.location === 'local'
                    ? 'Local-only projects may use it.'
                    : 'Only projects allowed external models may use it.'}
                </small>
              </dd>
              <dt>Key</dt>
              <dd>
                {key === null ? (
                  <>
                    <span>{keyText(e)}</span>
                    <button type="button" onClick={() => setKey('')}>
                      Set key
                    </button>
                    {e.keySet && (
                      <button type="button" onClick={() => void update({ apiKey: null })}>
                        Remove key
                      </button>
                    )}
                  </>
                ) : (
                  <span className="inline-edit">
                    <input
                      type="password"
                      aria-label="API key"
                      autoComplete="off"
                      value={key}
                      onChange={(ev) => setKey(ev.target.value)}
                    />
                    <button
                      type="button"
                      className="primary"
                      aria-label="Save key"
                      disabled={!key.trim()}
                      onClick={() =>
                        void update({ apiKey: key.trim() }).then((ok) => ok && setKey(null))
                      }
                    >
                      Save
                    </button>
                    <button type="button" onClick={() => setKey(null)}>
                      Cancel
                    </button>
                  </span>
                )}
              </dd>
            </dl>
            <div className="endpoint-actions">
              <button
                type="button"
                onClick={() =>
                  void act(() => api.discoverLlmEndpoint(e.name)).then(
                    (ok) =>
                      ok &&
                      setNotice(
                        'Discovery requested: new models appear as suggestions within a minute.',
                      ),
                  )
                }
              >
                <Icon name="refresh" />
                Discover models
              </button>
              <button type="button" onClick={() => void update({ enabled: !e.enabled })}>
                {e.enabled ? 'Disable' : 'Enable'}
              </button>
              {e.source === 'ui' && !confirmRemove && (
                <button type="button" className="danger" onClick={() => setConfirmRemove(true)}>
                  <Icon name="trash" />
                  Remove endpoint
                </button>
              )}
            </div>
            {e.source !== 'ui' && (
              <small className="muted">Set in .env, so it can&apos;t be removed here.</small>
            )}
            {confirmRemove && (
              <p className="confirm-text">
                Remove {e.name}? Jobs and transformation recipes naming its models will stop
                resolving.{' '}
                <button
                  type="button"
                  className="danger"
                  aria-label={`Confirm remove ${e.name}`}
                  onClick={() => void act(() => api.deleteLlmEndpoint(e.name))}
                >
                  Remove
                </button>{' '}
                <button type="button" onClick={() => setConfirmRemove(false)}>
                  Keep
                </button>
              </p>
            )}
            {notice && <p role="status">{notice}</p>}
            {error && <p role="alert">{error}</p>}
          </div>
          <div className="endpoint-offered">
            <div className="endpoint-offered-head">
              <span className="small-caps">Models offered · {offered.length}</span>
              <OfferModel endpoint={e} disabled={busy} onOffer={(id) => void offer([...ids, id])} />
            </div>
            {offered.length === 0 ? (
              <p className="muted">None yet: offer a discovered model, or add one by its id.</p>
            ) : (
              <ul className="offered-models" aria-label={`Models offered on ${e.name}`}>
                {offered.map((m) => (
                  <li key={m.modelId}>
                    <span className="option-text">
                      <span className="option-name">{modelName(m)}</span>
                      <span className="mono option-id">{m.modelId}</span>
                    </span>
                    <OutputLimit
                      model={m}
                      disabled={busy}
                      onSave={(maxOutputTokens) =>
                        void act(() =>
                          api.setLlmModelSettings(e.name, m.modelId, { maxOutputTokens }),
                        )
                      }
                    />
                    <button
                      type="button"
                      className="icon"
                      aria-label={`Stop offering ${modelName(m)}`}
                      title="Stop offering"
                      disabled={busy}
                      onClick={() => void offer(ids.filter((id) => id !== m.modelId))}
                    >
                      <Icon name="close" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** Offer a model ▾: the endpoint's discovered models not offered yet, or a new id. */
function OfferModel({
  endpoint: e,
  disabled,
  onOffer,
}: {
  endpoint: LlmEndpointView;
  disabled: boolean;
  onOffer: (modelId: string) => void;
}) {
  const p = usePopover();
  const [newId, setNewId] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const discovered = e.models.filter((m) => !m.curated);
  const id = newId.trim();
  const pick = (modelId: string) => {
    p.close();
    setNewId('');
    onOffer(modelId);
  };
  const addId = () => {
    if (id && !/\s/.test(id)) pick(id);
  };

  return (
    <div className="popover-anchor" ref={p.box} onKeyDown={p.onKeyDown}>
      <button
        type="button"
        ref={p.trigger}
        className="dropdown-trigger small"
        aria-haspopup="dialog"
        aria-expanded={p.open}
        disabled={disabled}
        onClick={() => p.setOpen(!p.open)}
      >
        <Icon name="plus" />
        Offer a model
        <Icon name="chevronDown" />
      </button>
      {p.open && (
        <div
          className="dropdown-pop offer-pop"
          role="dialog"
          aria-label={`Offer a model on ${e.name}`}
          onKeyDown={(ev) => moveFocus(ev, list.current, '[role="option"]')}
        >
          <div className="dropdown-group-head small-caps">Discovered on {e.name}</div>
          <div className="dropdown-list" role="listbox" aria-label="Discovered models" ref={list}>
            {discovered.length === 0 && (
              <p className="muted dropdown-empty">
                Nothing else discovered: try Discover models, or add one by its id.
              </p>
            )}
            {discovered.map((m, i) => (
              <button
                key={m.modelId}
                type="button"
                autoFocus={i === 0}
                role="option"
                aria-selected={false}
                className="dropdown-option"
                onClick={() => pick(m.modelId)}
              >
                <span className="option-text">
                  <span className="option-name">{modelName(m)}</span>
                  <span className="mono option-id">{m.modelId}</span>
                </span>
                <span className="tag tone-info">Suggested</span>
                <Icon name="plus" />
              </button>
            ))}
          </div>
          <div className="dropdown-foot">
            <span className="small-caps">Not listed? Add by model id</span>
            <span className="inline-edit">
              <input
                className="mono"
                aria-label="Add a model id"
                placeholder="model-id"
                autoFocus={discovered.length === 0}
                value={newId}
                onChange={(ev) => setNewId(ev.target.value)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') {
                    ev.preventDefault();
                    addId();
                  }
                }}
              />
              <button type="button" onClick={addId} disabled={!id || /\s/.test(id)}>
                Add
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function AddEndpoint({
  api,
  onClose,
  onAdded,
}: {
  api: Api;
  onClose: () => void;
  onAdded: () => void;
}) {
  const formId = useId();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProviderKind>('openai-chat');
  const [baseUrl, setBaseUrl] = useState('');
  const [location, setLocation] = useState<Location>('local');
  const [models, setModels] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createLlmEndpoint({
        name: name.trim(),
        kind,
        baseUrl: baseUrl.trim() || null,
        location,
        models: models
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Add endpoint"
      onClose={onClose}
      actions={
        <button type="submit" form={formId} className="primary" disabled={busy || !name.trim()}>
          Add
        </button>
      }
    >
      <form id={formId} className="dialog-form" onSubmit={(ev) => void submit(ev)}>
        <label>
          Name
          <input
            value={name}
            placeholder="gpu2"
            onChange={(ev) => setName(ev.target.value)}
            aria-describedby={`${formId}-name`}
          />
        </label>
        <small id={`${formId}-name`} className="muted">
          Models are named <code>{name.trim() || 'name'}/model-id</code>.
        </small>
        <label>
          Kind
          <select value={kind} onChange={(ev) => setKind(ev.target.value as ProviderKind)}>
            {(Object.keys(KIND_LABEL) as ProviderKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Base URL
          <input
            value={baseUrl}
            placeholder={kind === 'anthropic' ? 'provider default' : 'http://host:8000/v1'}
            onChange={(ev) => setBaseUrl(ev.target.value)}
          />
        </label>
        <div className="field">
          <span className="field-label">Location</span>
          <Segmented label="Location" options={LOCATIONS} value={location} onChange={setLocation} />
        </div>
        <label>
          Models (comma-separated)
          <input
            value={models}
            placeholder="llama-4-70b, qwen3-32b"
            onChange={(ev) => setModels(ev.target.value)}
          />
        </label>
        <label>
          API key (optional)
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(ev) => setApiKey(ev.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
