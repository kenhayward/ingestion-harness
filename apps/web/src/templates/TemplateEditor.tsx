import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { VALUE_TYPES, type ModelInfo } from '@ih/shared';
import type { Api, TemplateRecordView } from '../api/client.js';
import { QualityPanel } from './QualityPanel.js';
import {
  checkPathOptions,
  getIn,
  moveItem,
  removeAt,
  setIn,
  validateDefinition,
  type Definition,
} from './model.js';

type Path = (string | number)[];
type Tab = 'general' | 'sections' | 'outputs' | 'pipeline' | 'yaml' | 'quality';

const TABS: [Tab, string][] = [
  ['general', 'General'],
  ['sections', 'Sections'],
  ['outputs', 'Outputs'],
  ['pipeline', 'Pipeline'],
  ['yaml', 'YAML'],
  ['quality', 'Quality'],
];

/** Empty text means "not set": the key is dropped rather than stored as "". */
const opt = (value: string): string | undefined => (value.trim() === '' ? undefined : value);
const intList = (text: string): number[] =>
  text
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
const optInt = (text: string): number | undefined =>
  text.trim() === '' ? undefined : Math.trunc(Number(text));

export function TemplateEditor({
  api,
  templateId,
  version,
  onNavigate,
  embedded,
}: {
  api: Api;
  templateId: string;
  version: number;
  onNavigate: (hash: string) => void;
  /**
   * Set when hosted by the workbench: the Runs tab replaces the single-sample test run, and
   * publish / new draft / delete draft report back instead of navigating to Document types.
   */
  embedded?: { onChanged: () => void };
}) {
  const [view, setView] = useState<TemplateRecordView | null>(null);
  const [def, setDef] = useState<Definition>({});
  const [saved, setSaved] = useState('');
  const [tab, setTab] = useState<Tab>('general');
  const [yamlText, setYamlText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [sample, setSample] = useState<File | null>(null);

  const accept = (v: TemplateRecordView) => {
    setView(v);
    setDef(v.record.definition);
    setSaved(JSON.stringify(v.record.definition));
  };

  useEffect(() => {
    api.getTemplate(templateId, version).then(accept, (err: Error) => setError(err.message));
    api.listModels().then(setModels, () => setModels([]));
  }, [api, templateId, version]);

  const issues = useMemo(() => validateDefinition(def), [def]);

  if (error && !view) return <p role="alert">{error}</p>;
  if (!view) return <p>Loading…</p>;

  const { record } = view;
  const editable = record.status === 'draft';
  const dirty = JSON.stringify(def) !== saved;
  const update = (path: Path, value: unknown) => setDef((d) => setIn(d, path, value));

  const act = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const save = () =>
    act(async () => {
      accept(await api.saveTemplate(templateId, version, def));
      setMessage('Draft saved.');
    });
  const publish = () =>
    act(async () => {
      accept(await api.publishTemplate(templateId, version));
      setMessage(`Published v${version}.`);
      embedded?.onChanged();
    });
  const newDraft = () =>
    act(async () => {
      const { record: draft } = await api.newDraft(templateId, version);
      if (embedded) return embedded.onChanged();
      onNavigate(`#/templates/${draft.id}/${draft.version}`);
    });
  const removeDraft = () =>
    act(async () => {
      await api.deleteDraft(templateId, version);
      if (embedded) return embedded.onChanged();
      onNavigate('#/templates');
    });
  const testRun = () =>
    act(async () => {
      if (!sample) return;
      const job = await api.testRun(sample, templateId, version);
      setMessage(`Test run queued: job ${job.id}. It will appear in the jobs list for review.`);
    });
  const openTab = (t: Tab) => {
    if (t === 'yaml') setYamlText(toYaml(def, { lineWidth: 100 }));
    setTab(t);
  };
  const applyYaml = () => {
    try {
      const parsed = parseYaml(yamlText);
      if (!parsed || typeof parsed !== 'object') throw new Error('YAML must be a mapping');
      setDef({ ...(parsed as Definition), id: templateId, version });
      setMessage('YAML applied (not saved yet).');
    } catch (err) {
      setError(`YAML: ${(err as Error).message}`);
    }
  };

  const sections: { id: string }[] = def.document?.sections ?? [];
  const fields: { id: string }[] = def.outputs?.fields ?? [];
  const tables: { id: string }[] = def.outputs?.tables ?? [];
  const pipeline: Definition[] = def.pipeline ?? [];
  const paths = checkPathOptions(def);

  return (
    <section className="template-editor">
      <header>
        <a href="#/templates">← Document types</a>
        <h2>
          {String(def.name ?? templateId)} <small>v{version}</small>{' '}
          <span className={`status status-${record.status}`}>{record.status}</span>
        </h2>
        <div className="toolbar">
          {editable ? (
            <>
              <button type="button" onClick={save} disabled={!dirty}>
                Save draft
              </button>
              <button type="button" onClick={publish} disabled={dirty || issues.length > 0}>
                Publish
              </button>
              <button type="button" className="danger" onClick={removeDraft}>
                Delete draft
              </button>
            </>
          ) : (
            <button type="button" onClick={newDraft}>
              New draft from v{version}
            </button>
          )}
          <a href={api.exportUrl(templateId, version)}>Export YAML</a>
          {!embedded && (
            <>
              <label>
                Sample PDF
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => setSample(e.target.files?.[0] ?? null)}
                />
              </label>
              <button type="button" onClick={testRun} disabled={!sample}>
                Test run
              </button>
            </>
          )}
        </div>
        {dirty && <p className="hint">Unsaved changes.</p>}
        {message && <p role="status">{message}</p>}
        {error && <p role="alert">{error}</p>}
        {issues.length > 0 && (
          <ul aria-label="Validation issues" className="issues">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
      </header>

      <div role="tablist" aria-label="Template sections">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => openTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'quality' && <QualityPanel api={api} templateId={templateId} version={version} />}

      <fieldset disabled={!editable} className="editor-body">
        {tab === 'general' && (
          <div className="form-rows">
            <Text label="Name" value={def.name} onChange={(v) => update(['name'], v)} />
            <Area
              label="Description"
              rows={3}
              value={def.description}
              onChange={(v) => update(['description'], opt(v))}
            />
            <Area
              label="Preamble"
              rows={14}
              hint="Domain guidance placed at the top of every prompt."
              value={def.preamble}
              onChange={(v) => update(['preamble'], opt(v))}
            />
            <Select
              label="Review"
              value={getIn(def, ['review', 'required']) ?? 'on_warnings'}
              options={['on_warnings', 'always', 'never']}
              onChange={(v) => update(['review', 'required'], v)}
            />
            <Select
              label="OCR"
              value={getIn(def, ['document', 'ocr']) ?? 'auto'}
              options={['auto', 'always', 'never']}
              onChange={(v) => update(['document', 'ocr'], v)}
            />
            <Select
              label="Date order"
              value={getIn(def, ['document', 'dateOrder']) ?? 'DMY'}
              options={['DMY', 'MDY']}
              onChange={(v) => update(['document', 'dateOrder'], v)}
            />
            <label>
              Page markers
              <input
                type="checkbox"
                checked={getIn(def, ['document', 'pageMarkers']) ?? true}
                onChange={(e) => update(['document', 'pageMarkers'], e.target.checked)}
              />
            </label>
            <Text
              label="Copy anchor"
              hint="Regex marking the start of each copy in multi-copy PDFs (keeps one copy)."
              value={getIn(def, ['document', 'copies', 'anchor'])}
              onChange={(v) =>
                update(
                  ['document', 'copies'],
                  opt(v)
                    ? { select: 'last', ...(getIn(def, ['document', 'copies']) ?? {}), anchor: v }
                    : undefined,
                )
              }
            />
          </div>
        )}

        {tab === 'sections' && (
          <RowTable
            label="Sections"
            noun="section"
            columns={[
              ['Section ID', '16rem'],
              ['Anchor', undefined],
              ['Required', '6rem'],
            ]}
            items={sections}
            onChange={(items) => update(['document', 'sections'], items)}
            create={() => ({ id: '', anchor: '' })}
            cells={(s, i) => [
              <Text
                key="id"
                bare
                label={`Section ${i + 1} id`}
                value={s.id}
                onChange={(v) => update(['document', 'sections', i, 'id'], v)}
              />,
              <Text
                key="anchor"
                bare
                className="code"
                label={`Section ${i + 1} anchor`}
                hint="Multiline regex where the section starts"
                value={getIn(s, ['anchor'])}
                onChange={(v) => update(['document', 'sections', i, 'anchor'], v)}
              />,
              <input
                key="required"
                type="checkbox"
                aria-label={`Section ${i + 1} required`}
                checked={getIn(s, ['required']) ?? true}
                onChange={(e) => update(['document', 'sections', i, 'required'], e.target.checked)}
              />,
            ]}
          />
        )}

        {tab === 'outputs' && (
          <>
            <h3>Fields</h3>
            <ValueList
              label="Field"
              heading="Field"
              tableLabel="Fields"
              addLabel="Add field"
              items={fields}
              onChange={(items) => update(['outputs', 'fields'], items)}
              update={(i, key, v) => update(['outputs', 'fields', i, key], v)}
            />
            <h3>Tables</h3>
            <ListEditor
              label="table"
              items={tables}
              onChange={(items) => update(['outputs', 'tables'], items)}
              create={() => ({ id: '', columns: [] })}
              render={(t, ti) => (
                <div className="table-def">
                  <Text
                    label={`Table ${ti + 1} id`}
                    value={t.id}
                    onChange={(v) => update(['outputs', 'tables', ti, 'id'], v)}
                  />
                  <Text
                    label={`Table ${ti + 1} name`}
                    value={getIn(t, ['name'])}
                    onChange={(v) => update(['outputs', 'tables', ti, 'name'], opt(v))}
                  />
                  <ValueList
                    label={`Table ${ti + 1} column`}
                    heading="Column"
                    tableLabel={`Table ${ti + 1} columns`}
                    addLabel={`Add column to table ${ti + 1}`}
                    items={getIn(t, ['columns']) ?? []}
                    onChange={(items) => update(['outputs', 'tables', ti, 'columns'], items)}
                    update={(i, key, v) => update(['outputs', 'tables', ti, 'columns', i, key], v)}
                  />
                </div>
              )}
            />
          </>
        )}

        {tab === 'pipeline' && (
          <div className="pipeline">
            <datalist id="model-options">
              <option value="default" />
              {models.map((m) => (
                <option key={m.ref} value={m.ref} />
              ))}
            </datalist>
            {pipeline.map((step, i) => (
              <fieldset key={i} aria-label={`Step ${i + 1}`} className="step">
                <legend>
                  Step {i + 1} — {step.type}
                </legend>
                <div className="step-tools">
                  <button
                    type="button"
                    aria-label={`Move step ${i + 1} up`}
                    onClick={() => update(['pipeline'], moveItem(pipeline, i, -1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move step ${i + 1} down`}
                    onClick={() => update(['pipeline'], moveItem(pipeline, i, 1))}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="danger"
                    aria-label={`Remove step ${i + 1}`}
                    onClick={() => update(['pipeline'], removeAt(pipeline, i))}
                  >
                    Remove
                  </button>
                </div>
                {step.type === 'extract' ? (
                  <ExtractStep
                    step={step}
                    fields={fields.map((f) => f.id)}
                    tables={tables.map((t) => t.id)}
                    sections={sections.map((s) => s.id)}
                    set={(key, v) => update(['pipeline', i, key], v)}
                    replace={(next) => update(['pipeline', i], next)}
                  />
                ) : (
                  <CheckStep
                    step={step}
                    paths={paths}
                    set={(key, v) => update(['pipeline', i, key], v)}
                  />
                )}
              </fieldset>
            ))}
            <button
              type="button"
              onClick={() =>
                update(
                  ['pipeline'],
                  [...pipeline, { type: 'extract', id: '', fields: [], sections: [] }],
                )
              }
            >
              Add extract step
            </button>
            <button
              type="button"
              onClick={() =>
                update(
                  ['pipeline'],
                  [...pipeline, { type: 'check', id: '', values: '', reference: '' }],
                )
              }
            >
              Add check step
            </button>
          </div>
        )}

        {tab === 'yaml' && (
          <div className="yaml">
            <label>
              Template YAML
              <textarea
                rows={30}
                spellCheck={false}
                value={yamlText}
                onChange={(e) => setYamlText(e.target.value)}
              />
            </label>
            <button type="button" onClick={applyYaml}>
              Apply YAML
            </button>
          </div>
        )}
      </fieldset>
    </section>
  );
}

function ExtractStep({
  step,
  fields,
  tables,
  sections,
  set,
  replace,
}: {
  step: Definition;
  fields: string[];
  tables: string[];
  sections: string[];
  set: (key: string, value: unknown) => void;
  replace: (step: Definition) => void;
}) {
  const fillsTable = step.table !== undefined;
  const toggle = (key: 'fields' | 'sections', id: string, on: boolean) => {
    const current: string[] = step[key] ?? [];
    set(key, on ? [...current, id] : current.filter((x) => x !== id));
  };
  return (
    <div className="extract-step">
      <div className="grid step-settings">
        <Text label="Step id" value={step.id} onChange={(v) => set('id', v)} />
        <fieldset className="choice">
          <legend>Fills</legend>
          <label className="inline">
            <input
              type="radio"
              checked={!fillsTable}
              onChange={() => {
                const rest = { ...step };
                delete rest.table;
                delete rest.chunkPages;
                replace({ ...rest, fields: [] });
              }}
            />
            Fields
          </label>
          <label className="inline">
            <input
              type="radio"
              checked={fillsTable}
              onChange={() => replace({ ...step, fields: [], table: tables[0] ?? '' })}
            />
            A table
          </label>
        </fieldset>
        {fillsTable ? (
          <>
            <Select
              label="Table"
              value={step.table}
              options={tables}
              onChange={(v) => set('table', v)}
            />
            <Text
              label="Chunk pages"
              hint="Run once per N pages (large tables)"
              value={step.chunkPages === undefined ? '' : String(step.chunkPages)}
              onChange={(v) => set('chunkPages', optInt(v))}
            />
          </>
        ) : (
          <Checklist
            label="Fields to fill"
            options={fields}
            selected={step.fields ?? []}
            onToggle={(id, on) => toggle('fields', id, on)}
          />
        )}
        <Checklist
          label="Sections"
          options={sections}
          selected={step.sections ?? []}
          onToggle={(id, on) => toggle('sections', id, on)}
        />
        <label>
          Model
          <input
            list="model-options"
            value={step.model ?? ''}
            placeholder="default"
            onChange={(e) => set('model', opt(e.target.value))}
          />
        </label>
        <Text
          label="Page images"
          hint="1-based pages sent as images, e.g. 1"
          value={(step.pageImages ?? []).join(', ')}
          onChange={(v) => set('pageImages', intList(v).length ? intList(v) : undefined)}
        />
        <Text
          label="Max tokens"
          value={step.maxTokens === undefined ? '' : String(step.maxTokens)}
          onChange={(v) => set('maxTokens', optInt(v))}
        />
        <Text
          label="Max attempts"
          value={step.maxAttempts === undefined ? '' : String(step.maxAttempts)}
          onChange={(v) => set('maxAttempts', optInt(v))}
        />
      </div>
      <div className="step-prompts">
        <ContextEditor
          value={step.context ?? {}}
          onChange={(context) => set('context', Object.keys(context).length ? context : undefined)}
        />
        <Area
          label="Instructions"
          value={step.instructions}
          onChange={(v) => set('instructions', opt(v))}
        />
      </div>
    </div>
  );
}

/**
 * Values from earlier steps for the prompt, one per line: `name = field` or `name = table.column`.
 * Keeps its own text so half-typed lines aren't lost; only complete lines are stored.
 */
function ContextEditor({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}) {
  const [text, setText] = useState(() =>
    Object.entries(value)
      .map(([name, path]) => `${name} = ${path}`)
      .join('\n'),
  );
  return (
    <label
      className="context"
      title="One per line: name = field or table.column (must be filled by an earlier step)"
    >
      Context
      <textarea
        rows={2}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const entries = e.target.value
            .split('\n')
            .map((line) => line.split('='))
            .filter((parts) => parts.length === 2 && parts[0]!.trim() && parts[1]!.trim())
            .map(([name, path]) => [name!.trim(), path!.trim()] as const);
          onChange(Object.fromEntries(entries));
        }}
      />
    </label>
  );
}

function CheckStep({
  step,
  paths,
  set,
}: {
  step: Definition;
  paths: string[];
  set: (key: string, value: unknown) => void;
}) {
  return (
    <div className="grid">
      <Text label="Check id" value={step.id} onChange={(v) => set('id', v)} />
      <Select
        label="Values"
        value={step.values}
        options={paths}
        onChange={(v) => set('values', v)}
      />
      <Select
        label="Reference"
        value={step.reference}
        options={paths}
        onChange={(v) => set('reference', v)}
      />
      <Select
        label="Aliases"
        value={step.aliases ?? ''}
        options={['', ...paths]}
        onChange={(v) => set('aliases', opt(v))}
      />
      <Text
        label="Max distance"
        value={step.maxDistance === undefined ? '' : String(step.maxDistance)}
        onChange={(v) => set('maxDistance', optInt(v))}
      />
    </div>
  );
}

/** Fields or table columns, one per row: id, name, type, enum values, description. */
function ValueList({
  label,
  heading,
  tableLabel,
  addLabel,
  items,
  onChange,
  update,
}: {
  label: string;
  heading: string;
  tableLabel: string;
  addLabel: string;
  items: Definition[];
  onChange: (items: Definition[]) => void;
  update: (index: number, key: string, value: unknown) => void;
}) {
  return (
    <RowTable
      label={tableLabel}
      noun={label}
      addLabel={addLabel}
      columns={[
        [`${heading} ID`, '14rem'],
        ['Name', '16rem'],
        ['Type', '8rem'],
        ['Enum values', '14rem'],
        ['Description', undefined],
      ]}
      items={items}
      onChange={onChange}
      create={() => ({ id: '', type: 'text' })}
      cells={(item, i) => {
        const n = `${label} ${i + 1}`;
        return [
          <Text
            key="id"
            bare
            label={`${n} id`}
            value={item.id}
            onChange={(v) => update(i, 'id', v)}
          />,
          <Text
            key="name"
            bare
            label={`${n} name`}
            value={item.name}
            onChange={(v) => update(i, 'name', opt(v))}
          />,
          <Select
            key="type"
            bare
            label={`${n} type`}
            value={item.type ?? 'text'}
            options={[...VALUE_TYPES]}
            onChange={(v) => update(i, 'type', v)}
          />,
          item.type === 'enum' ? (
            <Text
              key="enum"
              bare
              label={`${n} enum`}
              hint="Comma-separated allowed values"
              value={(item.enum ?? []).join(', ')}
              onChange={(v) =>
                update(
                  i,
                  'enum',
                  v
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
          ) : null,
          <Text
            key="description"
            bare
            label={`${n} description`}
            value={item.description}
            onChange={(v) => update(i, 'description', opt(v))}
          />,
        ];
      }}
    />
  );
}

/**
 * One item per row under column headings. Each cell's input carries its own accessible label
 * (e.g. "Section 1 id"), so the headings are visual only.
 */
function RowTable<T extends Definition>({
  label,
  noun,
  addLabel = `Add ${noun}`,
  columns,
  items,
  onChange,
  create,
  cells,
}: {
  label: string;
  noun: string;
  addLabel?: string;
  columns: [heading: string, width: string | undefined][];
  items: T[];
  onChange: (items: T[]) => void;
  create: () => T;
  cells: (item: T, index: number) => ReactNode[];
}) {
  return (
    <div className="row-table">
      <table aria-label={label}>
        <thead>
          <tr>
            <th style={{ width: '2.5rem' }}>#</th>
            {columns.map(([heading, width]) => (
              <th key={heading} style={{ width }}>
                {heading}
              </th>
            ))}
            <th style={{ width: '11rem' }} />
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={i}>
              <td className="index">{i + 1}</td>
              {cells(item, i).map((cell, c) => (
                <td key={c}>{cell}</td>
              ))}
              <td>
                <div className="step-tools">
                  <button
                    type="button"
                    aria-label={`Move ${noun} ${i + 1} up`}
                    onClick={() => onChange(moveItem(items, i, -1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${noun} ${i + 1} down`}
                    onClick={() => onChange(moveItem(items, i, 1))}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="danger"
                    aria-label={`Remove ${noun} ${i + 1}`}
                    onClick={() => onChange(removeAt(items, i))}
                  >
                    Remove
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={() => onChange([...items, create()])}>
        {addLabel}
      </button>
    </div>
  );
}

function ListEditor<T extends Definition>({
  label,
  items,
  onChange,
  create,
  render,
}: {
  label: string;
  items: T[];
  onChange: (items: T[]) => void;
  create: () => T;
  render: (item: T, index: number) => ReactNode;
}) {
  return (
    <div className="list-editor">
      {items.map((item, i) => (
        <div key={i} className="list-item">
          {render(item, i)}
          <div className="step-tools">
            <button
              type="button"
              aria-label={`Move ${label} ${i + 1} up`}
              onClick={() => onChange(moveItem(items, i, -1))}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`Move ${label} ${i + 1} down`}
              onClick={() => onChange(moveItem(items, i, 1))}
            >
              ↓
            </button>
            <button
              type="button"
              className="danger"
              aria-label={`Remove ${label} ${i + 1}`}
              onClick={() => onChange(removeAt(items, i))}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...items, create()])}>
        Add {label}
      </button>
    </div>
  );
}

function Checklist({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <fieldset className="choice">
      <legend>{label}</legend>
      {options.length === 0 && <small>None defined yet.</small>}
      {options.map((id) => (
        <label key={id} className="inline">
          <input
            type="checkbox"
            checked={selected.includes(id)}
            onChange={(e) => onToggle(id, e.target.checked)}
          />
          {id}
        </label>
      ))}
    </fieldset>
  );
}

/** `bare` drops the visible label (table cells under a heading); it stays the accessible name. */
function Text({
  label,
  value,
  hint,
  bare,
  className,
  onChange,
}: {
  label: string;
  value: unknown;
  hint?: string;
  bare?: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  const input = (
    <input
      aria-label={bare ? label : undefined}
      title={bare ? hint : undefined}
      className={className}
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
  if (bare) return input;
  return (
    <label title={hint}>
      {label}
      {input}
    </label>
  );
}

function Area({
  label,
  value,
  hint,
  rows = 4,
  onChange,
}: {
  label: string;
  value: unknown;
  hint?: string;
  rows?: number;
  onChange: (value: string) => void;
}) {
  return (
    <label title={hint}>
      {label}
      <textarea
        rows={rows}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function Select({
  label,
  value,
  options,
  bare,
  onChange,
}: {
  label: string;
  value: unknown;
  options: string[];
  bare?: boolean;
  onChange: (value: string) => void;
}) {
  const current = value === undefined || value === null ? '' : String(value);
  const select = (
    <select
      aria-label={bare ? label : undefined}
      value={current}
      onChange={(e) => onChange(e.target.value)}
    >
      {!options.includes(current) && <option value={current}>{current || '— choose —'}</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {o || '—'}
        </option>
      ))}
    </select>
  );
  if (bare) return select;
  return (
    <label>
      {label}
      {select}
    </label>
  );
}
