import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { EndpointPatchBody, LlmChoicesView, LlmEndpointView, ProviderKind } from '@ih/shared';
import type { Api, Me } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { Icon } from '../ui/Icon.js';
import { Segmented } from '../ui/Segmented.js';
import { ChoicesSection, PipelineSection } from './ChoicesSection.js';

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

/** Where the endpoint's settings came from: .env, an admin's edit, or added here. */
function sourceText(e: LlmEndpointView): string {
  if (e.source === 'ui') return e.updatedBy ? `Added here by ${e.updatedBy}` : 'Added here';
  if (!e.editedAt) return 'From .env';
  return e.updatedBy ? `Edited by ${e.updatedBy}` : 'Edited here';
}

function keyText(e: LlmEndpointView): string {
  if (e.keySet) return 'Key stored (encrypted)';
  if (e.apiKeyEnv) return `Key from .env (${e.apiKeyEnv})`;
  return 'No key';
}

/** The models offered on enabled endpoints, as `endpoint/model-id`. */
export function offeredRefs(endpoints: readonly LlmEndpointView[]): string[] {
  return endpoints
    .filter((e) => e.enabled)
    .flatMap((e) =>
      e.models.filter((m) => m.curated && m.enabled).map((m) => `${e.name}/${m.modelId}`),
    )
    .sort();
}

/**
 * Models (ADR 0010): the labelled model choices people pick, the pipeline's OCR and drafting
 * models, and the LLM endpoints with the models each one offers. .env seeds them; changes made
 * here win. Admins only.
 */
export function ModelsPage({ api, me }: { api: Api; me: Me }) {
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
      <div className="page-header">
        <div>
          <h1>Models</h1>
          <p className="muted">
            The model choices people pick, the pipeline&apos;s own models, and the endpoints the
            worker sends requests to with the models each one offers. .env sets the defaults; what
            you change here wins and reaches the workers within seconds.
          </p>
        </div>
        <button type="button" className="primary" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          Add endpoint
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {endpoints === null && !error && <p>Loading…</p>}
      {endpoints && choices && (
        <>
          <ChoicesSection
            api={api}
            view={choices}
            offered={offeredRefs(endpoints)}
            onChanged={load}
          />
          <PipelineSection
            api={api}
            view={choices}
            offered={offeredRefs(endpoints)}
            onChanged={load}
          />
          <h2 className="endpoints-heading">Endpoints</h2>
        </>
      )}
      {endpoints?.length === 0 && <p className="muted">No endpoints yet.</p>}
      {endpoints?.map((e) => (
        <EndpointCard key={e.name} api={api} endpoint={e} onChanged={load} />
      ))}
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

function EndpointCard({
  api,
  endpoint: e,
  onChanged,
}: {
  api: Api;
  endpoint: LlmEndpointView;
  onChanged: () => Promise<void>;
}) {
  const curated = e.models.filter((m) => m.curated).map((m) => m.modelId);
  const [selected, setSelected] = useState<string[]>(curated);
  const [added, setAdded] = useState<string[]>([]);
  const [newId, setNewId] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const curatedKey = curated.join('\n');

  // A reload brings the stored choice: start from it again.
  useEffect(() => {
    setSelected(curatedKey ? curatedKey.split('\n') : []);
    setAdded([]);
  }, [curatedKey]);

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
  const update = (patch: EndpointPatchBody) => act(() => api.updateLlmEndpoint(e.name, patch));

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const addId = () => {
    const id = newId.trim();
    if (!id || /\s/.test(id)) return;
    if (!e.models.some((m) => m.modelId === id) && !added.includes(id)) setAdded([...added, id]);
    if (!selected.includes(id)) setSelected([...selected, id]);
    setNewId('');
  };
  const dirty = [...selected].sort().join('\n') !== [...curated].sort().join('\n');
  const rows = [
    ...e.models,
    ...added.map((modelId) => ({ modelId, displayName: null, curated: false, enabled: true })),
  ];

  return (
    <section
      className={e.enabled ? 'endpoint-card' : 'endpoint-card disabled'}
      aria-label={`Endpoint ${e.name}`}
    >
      <header className="endpoint-head">
        <h2 className="mono">{e.name}</h2>
        <span className="tag tone-neutral">{KIND_LABEL[e.kind]}</span>
        <span className={`tag tone-${e.source === 'env' && !e.editedAt ? 'neutral' : 'info'}`}>
          {sourceText(e)}
        </span>
        {!e.enabled && <span className="tag tone-warn">Disabled</span>}
        <span className="endpoint-actions">
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
        </span>
      </header>
      {confirmRemove && (
        <p className="confirm-text">
          Remove {e.name}? Jobs and templates naming its models will stop resolving.{' '}
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
      <dl className="meta endpoint-meta">
        <dt>Base URL</dt>
        <dd>
          {url === null ? (
            <>
              <code>{e.baseUrl ?? 'provider default'}</code>{' '}
              <button
                type="button"
                className="link"
                aria-label="Edit base URL"
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
                  void update({ baseUrl: url.trim() || null }).then((ok) => ok && setUrl(null))
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
              <span>{keyText(e)}</span>{' '}
              <button type="button" className="link" onClick={() => setKey('')}>
                Set key
              </button>
              {e.keySet && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="link"
                    onClick={() => void update({ apiKey: null })}
                  >
                    Remove key
                  </button>
                </>
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
                onClick={() => void update({ apiKey: key.trim() }).then((ok) => ok && setKey(null))}
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
      <fieldset className="endpoint-models">
        <legend>Models offered</legend>
        {rows.length === 0 && <p className="muted">No models yet: add one by its id.</p>}
        <ul>
          {rows.map((m) => (
            <li key={m.modelId}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(m.modelId)}
                  onChange={() => toggle(m.modelId)}
                />
                {m.displayName ? `${m.displayName} (${m.modelId})` : m.modelId}
                {!m.curated && !added.includes(m.modelId) && (
                  <span className="tag tone-neutral"> suggested</span>
                )}
              </label>
            </li>
          ))}
        </ul>
        <div className="actions">
          <input
            aria-label="Add a model id"
            placeholder="model id, e.g. qwen3-32b"
            value={newId}
            onChange={(ev) => setNewId(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') {
                ev.preventDefault();
                addId();
              }
            }}
          />
          <button type="button" onClick={addId} disabled={!newId.trim()}>
            <Icon name="plus" />
            Add
          </button>
          <button
            type="button"
            className="primary"
            disabled={!dirty}
            onClick={() => void act(() => api.setLlmEndpointModels(e.name, [...selected].sort()))}
          >
            Save models
          </button>
        </div>
      </fieldset>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
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
