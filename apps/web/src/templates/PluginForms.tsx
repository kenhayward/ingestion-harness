import { Fragment, useEffect, useRef, useState } from 'react';
import type { ModelChoice, PluginInfo, PluginPreviewView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { ModelPicker } from '../ui/ModelPicker.js';
import { Text } from './fields.js';
import { repeatNote, type SectionLike } from './editor-derive.js';
import type { Definition } from './model.js';
import { setSetting, settingsFields, type SettingField } from './settings-schema.js';
import { ContextEditor, RepeatKeyColumn } from './StepForms.js';

/** The plugins recipe steps can run (recipe plugins 3b); [] until loaded or when none. */
export function usePlugins(api: Api): PluginInfo[] {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  useEffect(() => {
    let live = true;
    api.listPlugins().then(
      (list) => live && setPlugins(list),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);
  return plugins;
}

const NO_PLUGINS = 'No plugins yet: no worker has published any';

/** "+ Add plugin step…": picking a plugin adds a step running it, to be set up in its form. */
export function AddPluginStep({
  plugins,
  onAdd,
}: {
  plugins: readonly PluginInfo[];
  onAdd: (step: Definition) => void;
}) {
  return (
    <select
      className="add"
      aria-label="Add plugin step"
      value=""
      disabled={plugins.length === 0}
      title={plugins.length === 0 ? NO_PLUGINS : undefined}
      onChange={(e) => {
        if (e.target.value) {
          onAdd({ type: 'plugin', id: '', uses: e.target.value, fields: [], sections: [] });
        }
      }}
    >
      <option value="">+ Add plugin step…</option>
      {plugins.map((p) => (
        <option key={p.ref} value={p.ref} title={p.summary}>
          {p.ref}
        </option>
      ))}
    </select>
  );
}

const idsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * A plugin step's form (recipe plugins 3c): its id, the plugin it runs, what it fills and reads,
 * its context, and its settings as a form from the plugin's schema (as JSON for a plugin no
 * worker has published).
 */
export function PluginStepForm({
  step,
  plugins,
  sectionDefs,
  fields,
  tables,
  tableColumns = {},
  models = [],
  typeModelLabel = 'Default choice',
  set,
  replace,
}: {
  step: Definition;
  plugins: readonly PluginInfo[];
  sectionDefs: readonly SectionLike[];
  fields: string[];
  tables: string[];
  /** Each table's column ids, for the key column of a step reading a repeating section. */
  tableColumns?: Record<string, string[]>;
  /** The model choices, for a plugin that calls a model. */
  models?: readonly ModelChoice[];
  /** The model picker's empty option: what a step naming no model inherits. */
  typeModelLabel?: string;
  set: (key: string, value: unknown) => void;
  replace: (step: Definition) => void;
}) {
  const uses = typeof step.uses === 'string' ? step.uses : '';
  const plugin = plugins.find((p) => p.ref === uses);
  const table = typeof step.table === 'string' ? step.table : '';
  const filled = idsOf(step.fields);
  const reads = idsOf(step.sections);
  const { disabled } = repeatNote(step, sectionDefs);
  const settings = (step.with ?? {}) as Record<string, unknown>;
  const setSettings = (next: Record<string, unknown>) =>
    set('with', Object.keys(next).length > 0 ? next : undefined);
  return (
    <div className="step-detail-body plugin-step">
      <div className="grid step-settings">
        <Text label="Step id" value={step.id} onChange={(v) => set('id', v)} />
        <label>
          Plugin
          <select
            aria-label="Plugin"
            value={uses}
            onChange={(e) => {
              // Settings belong to a plugin: another plugin starts without them, and
              // without a model unless it calls one.
              const next: Definition = { ...step, uses: e.target.value };
              delete next.with;
              const chosen = plugins.find((p) => p.ref === e.target.value);
              if (chosen?.egress !== 'model') delete next.model;
              replace(next);
            }}
          >
            {!plugin && (
              <option
                value={uses}
              >{`${uses || '(none)'} (not on this deployment's workers)`}</option>
            )}
            {plugins.map((p) => (
              <option key={p.ref} value={p.ref}>
                {p.ref}
              </option>
            ))}
          </select>
          {plugin && <small className="muted">{plugin.summary}</small>}
        </label>
        {(plugin?.egress === 'model' || step.model !== undefined) && (
          <div className="field">
            <span className="field-label">Model</span>
            <ModelPicker
              label="Model"
              choices={models}
              value={step.model === 'default' ? '' : (step.model ?? '')}
              emptyLabel={typeModelLabel}
              onChange={(id) => set('model', id || undefined)}
            />
            {plugin?.egress === 'model' && (
              <small className="muted">This plugin asks a model.</small>
            )}
          </div>
        )}
      </div>
      <fieldset className="section-checks">
        <legend>Fills</legend>
        <ul className="section-check-list">
          {fields.map((f) => (
            <li key={f}>
              <label className="section-check">
                <input
                  type="checkbox"
                  checked={filled.includes(f)}
                  disabled={table !== ''}
                  onChange={(e) =>
                    set('fields', e.target.checked ? [...filled, f] : filled.filter((x) => x !== f))
                  }
                />
                <code>{f}</code>
              </label>
            </li>
          ))}
        </ul>
        {tables.length > 0 && (
          <label>
            or a table
            <select
              aria-label="Fills a table"
              value={table}
              onChange={(e) => {
                const next: Definition = { ...step, fields: [] };
                if (e.target.value) next.table = e.target.value;
                else delete next.table;
                replace(next);
              }}
            >
              <option value="">(fields)</option>
              {tables.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        )}
      </fieldset>
      <fieldset className="section-checks">
        <legend>Reads sections</legend>
        {sectionDefs.length === 0 ? (
          <small>No sections defined yet.</small>
        ) : (
          <ul className="section-check-list">
            {sectionDefs.map((s) => (
              <li key={s.id}>
                <label className="section-check" title={disabled[s.id]}>
                  <input
                    type="checkbox"
                    checked={reads.includes(s.id)}
                    disabled={disabled[s.id] !== undefined && !reads.includes(s.id)}
                    onChange={(e) =>
                      set(
                        'sections',
                        e.target.checked ? [...reads, s.id] : reads.filter((x) => x !== s.id),
                      )
                    }
                  />
                  <code>{s.id}</code>
                </label>
              </li>
            ))}
          </ul>
        )}
        <small className="muted">None: the plugin reads only earlier values (its context).</small>
        <RepeatKeyColumn
          step={step}
          sectionDefs={sectionDefs}
          columns={tableColumns[table] ?? []}
          set={set}
        />
      </fieldset>
      <ContextEditor
        value={(step.context ?? {}) as Record<string, string>}
        onChange={(context) => set('context', Object.keys(context).length ? context : undefined)}
      />
      <fieldset className="plugin-settings">
        <legend>Settings</legend>
        {plugin ? (
          <SettingsForm
            schema={plugin.settingsSchema}
            value={settings}
            onChange={setSettings}
            keySuggestions={table ? [] : filled}
          />
        ) : (
          <JsonSettings
            value={step.with}
            label="Settings (JSON)"
            onChange={(v) =>
              setSettings(
                v && typeof v === 'object' && !Array.isArray(v)
                  ? (v as Record<string, unknown>)
                  : {},
              )
            }
          />
        )}
      </fieldset>
    </div>
  );
}

/** A form for a plugin's settings, field by field from its JSON Schema. */
export function SettingsForm({
  schema,
  value,
  onChange,
  keySuggestions = [],
}: {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  /** Keys offered for a map (a field step's fields, for text.pattern's patterns). */
  keySuggestions?: string[];
}) {
  const fields = settingsFields(schema);
  if (fields.length === 0) return <small className="muted">This plugin takes no settings.</small>;
  return (
    <div className="settings-form">
      {fields.map((f) => (
        <SettingInput
          key={f.key}
          field={f}
          value={value[f.key]}
          keySuggestions={keySuggestions}
          onChange={(v) => onChange(setSetting(value, f.key, v, f.fallback))}
        />
      ))}
    </div>
  );
}

function SettingInput({
  field,
  value,
  keySuggestions,
  onChange,
}: {
  field: SettingField;
  value: unknown;
  keySuggestions: string[];
  onChange: (value: unknown) => void;
}) {
  const hint = field.description;
  switch (field.kind) {
    case 'boolean':
      return (
        <label className="check" title={hint}>
          <input
            type="checkbox"
            checked={value === undefined ? field.fallback === true : value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {field.title}
        </label>
      );
    case 'integer':
    case 'number':
      return (
        <label title={hint}>
          {field.title}
          <input
            type="number"
            step={field.kind === 'integer' ? 1 : 'any'}
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
          {hint && <small className="muted">{hint}</small>}
        </label>
      );
    case 'enum':
      return (
        <label title={hint}>
          {field.title}
          <select
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">(not set)</option>
            {(field.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          {hint && <small className="muted">{hint}</small>}
        </label>
      );
    case 'list':
      return (
        <label title={hint}>
          {field.title}
          <textarea
            rows={3}
            value={Array.isArray(value) ? value.join('\n') : ''}
            onChange={(e) => onChange(e.target.value.split('\n').filter((l) => l.trim() !== ''))}
          />
          <small className="muted">{hint ? `${hint} ` : ''}One per line.</small>
        </label>
      );
    case 'map':
      return (
        <MapInput
          field={field}
          value={(value ?? {}) as Record<string, string>}
          keySuggestions={keySuggestions}
          onChange={onChange}
        />
      );
    case 'json':
      return <JsonSettings value={value} label={`${field.title} (JSON)`} onChange={onChange} />;
    default:
      return (
        <label title={hint}>
          {field.title}
          <input
            className="mono"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          />
          {hint && <small className="muted">{hint}</small>}
        </label>
      );
  }
}

/** A text map (text.pattern's patterns: field id to pattern): one row per key. */
function MapInput({
  field,
  value,
  keySuggestions,
  onChange,
}: {
  field: SettingField;
  value: Record<string, string>;
  keySuggestions: string[];
  onChange: (value: unknown) => void;
}) {
  const [key, setKey] = useState('');
  const listId = `keys-${field.key}`;
  const add = () => {
    const k = key.trim();
    if (!k || k in value) return;
    onChange({ ...value, [k]: '' });
    setKey('');
  };
  return (
    <fieldset className="map-input" title={field.description}>
      <legend>{field.title}</legend>
      {field.description && <small className="muted">{field.description}</small>}
      <ul>
        {Object.entries(value).map(([k, v]) => (
          <li key={k}>
            <code>{k}</code>
            <input
              className="mono"
              aria-label={`${field.title}: ${k}`}
              value={v}
              onChange={(e) => onChange({ ...value, [k]: e.target.value })}
            />
            <button
              type="button"
              className="icon"
              aria-label={`Remove ${k} from ${field.title}`}
              onClick={() => {
                const next = { ...value };
                delete next[k];
                onChange(next);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="map-add">
        <input
          aria-label={`New key for ${field.title}`}
          list={keySuggestions.length ? listId : undefined}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        {keySuggestions.length > 0 && (
          <datalist id={listId}>
            {keySuggestions
              .filter((s) => !(s in value))
              .map((s) => (
                <option key={s} value={s} />
              ))}
          </datalist>
        )}
        <button type="button" onClick={add} disabled={!key.trim() || key.trim() in value}>
          Add to {field.title}
        </button>
      </div>
    </fieldset>
  );
}

/** Settings edited as JSON: kept as typed until it parses. */
function JsonSettings({
  value,
  label,
  onChange,
}: {
  value: unknown;
  label: string;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(() =>
    value === undefined ? '' : JSON.stringify(value, null, 2),
  );
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <label>
      {label}
      <textarea
        className="mono"
        rows={6}
        aria-label={label}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === '') {
            setProblem(null);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value) as unknown);
            setProblem(null);
          } catch {
            setProblem('Not valid JSON yet: nothing is saved until it is.');
          }
        }}
      />
      {problem && <small className="error">{problem}</small>}
    </label>
  );
}

const ACTIVE = new Set(['queued', 'running']);

/**
 * A plugin step's preview (recipe plugins 3c, Workbench only: it needs prepared dev samples): the
 * saved draft's step run on each dev sample, with the typed values or rows, the values that could
 * not be typed, and why a sample (or the whole preview) could not run.
 */
export function PluginPreview({
  api,
  projectId,
  stepId,
  dirty,
}: {
  api: Api;
  projectId: string;
  stepId: string;
  dirty: boolean;
}) {
  const [view, setView] = useState<PluginPreviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const poll = (jobId: string, delay: number) => {
    timer.current = setTimeout(() => {
      api.getPluginPreview(projectId, jobId).then(
        (next) => {
          setView(next);
          if (ACTIVE.has(next.status)) poll(jobId, 1000);
          else setBusy(false);
        },
        (err: unknown) => {
          setError((err as Error).message);
          setBusy(false);
        },
      );
    }, delay);
  };
  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      const started = await api.startPluginPreview(projectId, stepId);
      setView(started);
      poll(started.jobId, 0);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const blocked = dirty
    ? 'Save the draft first: the preview runs the saved draft'
    : !stepId
      ? 'Give the step an id first'
      : undefined;
  const result = view?.result;
  const failed = view && !ACTIVE.has(view.status) && view.status !== 'succeeded';
  return (
    <section className="plugin-preview" aria-label="Preview">
      <div className="plugin-preview-head">
        <button type="button" disabled={busy || !!blocked} title={blocked} onClick={start}>
          Preview on dev samples
        </button>
        {busy && <span className="muted">Running the plugin on the dev samples…</span>}
      </div>
      {error && <p role="alert">{error}</p>}
      {failed && <p role="alert">{view.error ?? 'The preview did not finish.'}</p>}
      {result?.problem && <p role="alert">{result.problem}</p>}
      {result?.samples.map((s) => (
        <section key={s.sampleId} className="card plugin-preview-sample" aria-label={s.fileName}>
          <h4 className="mono">{s.fileName}</h4>
          {s.error ? (
            <p className="muted">{s.error}</p>
          ) : s.fields ? (
            <dl className="step-facts">
              {Object.entries(s.fields).map(([field, v]) => (
                <Fragment key={field}>
                  <dt>
                    <code>{field}</code>
                  </dt>
                  <dd>
                    {v.value === null || v.value === undefined ? (
                      <span className="muted">no match</span>
                    ) : (
                      <span>{String(v.value)}</span>
                    )}
                    {typeof v.evidence === 'string' && (
                      <small className="muted evidence">{v.evidence}</small>
                    )}
                    {typeof v.page === 'number' && (
                      <small className="muted"> · page {v.page}</small>
                    )}
                  </dd>
                </Fragment>
              ))}
            </dl>
          ) : (
            <RowsTable rows={s.rows ?? []} />
          )}
          {s.issues.length > 0 && (
            <ul className="plugin-preview-issues">
              {s.issues.map((i, n) => (
                <li key={n} className="muted">
                  {String(i.target ?? '')}
                  {typeof i.row === 'number' ? ` row ${i.row}` : ''}
                  {i.column ? `.${String(i.column)}` : ''}: {String(i.message ?? '')}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </section>
  );
}

function RowsTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return <p className="muted">No rows matched.</p>;
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return (
    <table className="preview-rows">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} scope="col">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {columns.map((c) => (
              <td key={c}>{r[c] === null || r[c] === undefined ? '' : String(r[c])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
