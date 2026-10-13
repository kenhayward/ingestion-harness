import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { pickedChoice, VALUE_TYPES, type JobSummary } from '@ih/shared';
import type { Api, TemplateRecordView } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { YamlEditor } from '../ui/YamlEditor.js';
import { EditorHeader } from './EditorHeader.js';
import { tabCounts } from './editor-derive.js';
import { StepCard } from './StepCard.js';
import { TestRail } from './TestRail.js';
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
import { ModelPicker, useModelChoices } from '../ui/ModelPicker.js';
import { Area, opt, Select, Text } from './fields.js';
import { CheckStep, defaultLabel, ExtractStep } from './StepForms.js';

type Path = (string | number)[];
type Tab = 'general' | 'sections' | 'outputs' | 'pipeline' | 'yaml' | 'quality';

const TABS: [Tab, string][] = [
  ['general', 'General'],
  ['sections', 'Sections'],
  ['pipeline', 'Pipeline'],
  ['outputs', 'Outputs'],
  ['yaml', 'YAML'],
  ['quality', 'Quality'],
];

export function TemplateEditor({
  api,
  templateId,
  version,
  onNavigate,
  jobs = [],
  embedded,
}: {
  api: Api;
  templateId: string;
  version: number;
  onNavigate: (hash: string) => void;
  /** The polled job list: the Test this draft rail shows recent test runs from it. */
  jobs?: readonly JobSummary[];
  /**
   * Set when hosted by the workbench: the Runs tab replaces the single-sample test run (no Test
   * this draft rail), publish goes through the Workbench (`api.publish`: no references or
   * evaluation needed, and the publication is logged), and publish / new draft / delete draft
   * report back instead of navigating to Document types.
   */
  embedded?: { onChanged: () => void };
}) {
  const [view, setView] = useState<TemplateRecordView | null>(null);
  const [def, setDef] = useState<Definition>({});
  const [saved, setSaved] = useState('');
  const [tab, setTab] = useState<Tab>('general');
  const [outputsTab, setOutputsTab] = useState<'fields' | 'tables'>('fields');
  /** The table configured below the Tables list (clamped to the list). */
  const [tableIndex, setTableIndex] = useState(0);
  const [yamlText, setYamlText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const models = useModelChoices(api);
  const modelName = (id: string) => pickedChoice(id, models)?.label ?? id;
  /** The document type's model choice, which steps naming none inherit ('' = the default). */
  const typeModel = typeof def.model === 'string' && def.model !== 'default' ? def.model : '';
  /** The one pipeline step whose card is open (null: all collapsed). */
  const [openStep, setOpenStep] = useState<number | null>(null);
  /** Latest published version of this type, for "from published vN" (null: never published). */
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);

  const accept = (v: TemplateRecordView) => {
    setView(v);
    setDef(v.record.definition);
    setSaved(JSON.stringify(v.record.definition));
  };

  useEffect(() => {
    api.getTemplate(templateId, version).then(accept, (err: Error) => setError(err.message));
    api.listTemplates().then(
      (items) => setPublishedVersion(items.find((t) => t.id === templateId)?.published ?? null),
      () => setPublishedVersion(null),
    );
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
      if (embedded) {
        await api.publish(templateId);
        accept(await api.getTemplate(templateId, version));
      } else {
        accept(await api.publishTemplate(templateId, version));
      }
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
  const counts = tabCounts(def);
  const tabCount = (t: Tab): string | null =>
    t === 'sections'
      ? String(counts.sections)
      : t === 'outputs'
        ? `${counts.fields} · ${counts.tables}`
        : t === 'pipeline'
          ? String(counts.steps)
          : null;

  return (
    <section className="template-editor">
      <EditorHeader
        name={String(def.name ?? templateId)}
        id={templateId}
        version={version}
        status={record.status}
        publishedVersion={publishedVersion}
        dirty={dirty}
        issues={issues.length}
        exportUrl={api.exportUrl(templateId, version)}
        onSave={() => void save()}
        onPublish={() => void publish()}
        onNewDraft={() => void newDraft()}
        onDeleteDraft={() => void removeDraft()}
      />
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {issues.length > 0 && (
        <ul aria-label="Validation issues" className="issues">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}

      <div className="editor-layout">
        <div className="editor-main">
          <div role="tablist" aria-label="Template sections">
            {TABS.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => openTab(id)}>
                {label}
                {tabCount(id) && (
                  <>
                    {' '}
                    <span className="tab-count">{tabCount(id)}</span>
                  </>
                )}
              </button>
            ))}
          </div>

          {tab === 'quality' && (
            <QualityPanel api={api} templateId={templateId} version={version} />
          )}

          <fieldset disabled={!editable} className="editor-body">
            {tab === 'general' && (
              <div className="form-rows">
                <Text label="Name" value={def.name} onChange={(v) => update(['name'], v)} />
                <div className="model-row">
                  <span>Default model</span>
                  <ModelPicker
                    label="Default model"
                    choices={models}
                    value={typeModel}
                    emptyLabel={`Default choice${defaultLabel(models)}`}
                    onChange={(id) => update(['model'], id || undefined)}
                  />
                </div>
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
                  hint="Regex marking the start of each copy in multi-copy documents (keeps one copy). Pages of a Word document are those of its converted PDF."
                  value={getIn(def, ['document', 'copies', 'anchor'])}
                  onChange={(v) =>
                    update(
                      ['document', 'copies'],
                      opt(v)
                        ? {
                            select: 'last',
                            ...(getIn(def, ['document', 'copies']) ?? {}),
                            anchor: v,
                          }
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
                    onChange={(e) =>
                      update(['document', 'sections', i, 'required'], e.target.checked)
                    }
                  />,
                ]}
              />
            )}

            {tab === 'outputs' && (
              <>
                <div role="tablist" aria-label="Outputs" className="sub-tabs">
                  {(
                    [
                      ['fields', 'Fields', counts.fields],
                      ['tables', 'Tables', counts.tables],
                    ] as const
                  ).map(([id, label, count]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={outputsTab === id}
                      onClick={() => setOutputsTab(id)}
                    >
                      {label} <span className="tab-count">{count}</span>
                    </button>
                  ))}
                </div>
                {outputsTab === 'fields' ? (
                  <ValueList
                    label="Field"
                    heading="Field"
                    tableLabel="Fields"
                    addLabel="Add field"
                    items={fields}
                    onChange={(items) => update(['outputs', 'fields'], items)}
                    update={(i, key, v) => update(['outputs', 'fields', i, key], v)}
                  />
                ) : (
                  <TableOutputs
                    tables={tables}
                    selected={Math.min(tableIndex, tables.length - 1)}
                    onSelect={setTableIndex}
                    onChange={(items) => update(['outputs', 'tables'], items)}
                    render={(t, ti) => (
                      <div className="table-def">
                        <div className="table-def-names">
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
                        </div>
                        <ValueList
                          label={`Table ${ti + 1} column`}
                          heading="Column"
                          tableLabel={`Table ${ti + 1} columns`}
                          addLabel={`Add column to table ${ti + 1}`}
                          items={getIn(t, ['columns']) ?? []}
                          onChange={(items) => update(['outputs', 'tables', ti, 'columns'], items)}
                          update={(i, key, v) =>
                            update(['outputs', 'tables', ti, 'columns', i, key], v)
                          }
                        />
                      </div>
                    )}
                  />
                )}
              </>
            )}

            {tab === 'yaml' && (
              <div className="yaml">
                <YamlEditor
                  label="Template YAML"
                  value={yamlText}
                  onChange={setYamlText}
                  readOnly={!editable}
                />
                <button type="button" onClick={applyYaml}>
                  Apply YAML
                </button>
              </div>
            )}
          </fieldset>
          {/* Outside the disabled fieldset: a published version's steps still open (read-only). */}
          {tab === 'pipeline' && (
            <div className="pipeline">
              {pipeline.map((step, i) => (
                <StepCard
                  key={i}
                  index={i}
                  step={step}
                  open={openStep === i}
                  readOnly={!editable}
                  modelName={modelName}
                  inheritedModel={
                    typeModel ? `${modelName(typeModel)} (document type)` : 'default model'
                  }
                  onToggle={() => setOpenStep(openStep === i ? null : i)}
                  onMove={(delta) => {
                    const to = i + delta;
                    if (to < 0 || to >= pipeline.length) return;
                    update(['pipeline'], moveItem(pipeline, i, delta));
                    // The open card follows its step; a card swapped past it takes its old place.
                    if (openStep === i) setOpenStep(to);
                    else if (openStep === to) setOpenStep(i);
                  }}
                  onRemove={() => {
                    update(['pipeline'], removeAt(pipeline, i));
                    if (openStep === i) setOpenStep(null);
                    else if (openStep !== null && openStep > i) setOpenStep(openStep - 1);
                  }}
                >
                  {step.type === 'extract' ? (
                    <ExtractStep
                      step={step}
                      fields={fields.map((f) => f.id)}
                      tables={tables.map((t) => t.id)}
                      sections={sections.map((s) => s.id)}
                      models={models}
                      typeModelLabel={
                        typeModel
                          ? `Document type's model (${modelName(typeModel)})`
                          : `Default choice${defaultLabel(models)}`
                      }
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
                </StepCard>
              ))}
              <button
                type="button"
                className="add"
                disabled={!editable}
                onClick={() => {
                  update(
                    ['pipeline'],
                    [...pipeline, { type: 'extract', id: '', fields: [], sections: [] }],
                  );
                  setOpenStep(pipeline.length);
                }}
              >
                Add extract step
              </button>
              <button
                type="button"
                className="add"
                disabled={!editable}
                onClick={() => {
                  update(
                    ['pipeline'],
                    [...pipeline, { type: 'check', id: '', values: '', reference: '' }],
                  );
                  setOpenStep(pipeline.length);
                }}
              >
                Add check step
              </button>
            </div>
          )}
        </div>
        {!embedded && (
          <TestRail
            api={api}
            templateId={templateId}
            version={version}
            jobs={jobs}
            typeModel={typeModel ? { model: typeModel } : {}}
          />
        )}
      </div>
    </section>
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
                    className="icon bordered"
                    aria-label={`Move ${noun} ${i + 1} up`}
                    onClick={() => onChange(moveItem(items, i, -1))}
                  >
                    <Icon name="chevronUp" />
                  </button>
                  <button
                    type="button"
                    className="icon bordered"
                    aria-label={`Move ${noun} ${i + 1} down`}
                    onClick={() => onChange(moveItem(items, i, 1))}
                  >
                    <Icon name="chevronDown" />
                  </button>
                  <button
                    type="button"
                    className="icon bordered danger"
                    aria-label={`Remove ${noun} ${i + 1}`}
                    onClick={() => onChange(removeAt(items, i))}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="add" onClick={() => onChange([...items, create()])}>
        {addLabel}
      </button>
    </div>
  );
}

/**
 * Output tables: a list to pick from (with order and remove), and the picked table's settings
 * below it. Adding a table selects it.
 */
function TableOutputs({
  tables,
  selected,
  onSelect,
  onChange,
  render,
}: {
  tables: Definition[];
  /** Index of the configured table; -1 when there are none. */
  selected: number;
  onSelect: (index: number) => void;
  onChange: (tables: Definition[]) => void;
  render: (table: Definition, index: number) => ReactNode;
}) {
  const name = (t: Definition, i: number) => (t.id ? `table ${t.id}` : `table ${i + 1}`);
  const move = (i: number, by: -1 | 1) => {
    const to = i + by;
    onChange(moveItem(tables, i, by));
    if (selected === i) onSelect(to);
    else if (selected === to) onSelect(i);
  };
  const remove = (i: number) => {
    onChange(removeAt(tables, i));
    if (i < selected) onSelect(selected - 1);
  };
  const current = selected >= 0 ? tables[selected] : undefined;
  return (
    <div className="table-outputs">
      {tables.length === 0 ? (
        <p className="muted">No tables yet.</p>
      ) : (
        <div className="row-table">
          <table aria-label="Tables">
            <thead>
              <tr>
                <th>#</th>
                <th>Table ID</th>
                <th>Name</th>
                <th>Columns</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tables.map((t, i) => {
                const columns = Array.isArray(t.columns) ? t.columns.length : 0;
                return (
                  <tr key={i} className={i === selected ? 'selected' : undefined}>
                    <td className="muted">{i + 1}</td>
                    <td>
                      <button
                        type="button"
                        className="doc-button mono"
                        aria-pressed={i === selected}
                        aria-label={`Configure ${name(t, i)}`}
                        onClick={() => onSelect(i)}
                      >
                        {t.id || <em className="muted">no id yet</em>}
                      </button>
                    </td>
                    <td>
                      {typeof t.name === 'string' ? t.name : <span className="muted">—</span>}
                    </td>
                    <td className="muted">
                      {columns} {columns === 1 ? 'column' : 'columns'}
                    </td>
                    <td>
                      <div className="step-tools">
                        <button
                          type="button"
                          className="icon bordered"
                          aria-label={`Move table ${i + 1} up`}
                          disabled={i === 0}
                          onClick={() => move(i, -1)}
                        >
                          <Icon name="chevronUp" />
                        </button>
                        <button
                          type="button"
                          className="icon bordered"
                          aria-label={`Move table ${i + 1} down`}
                          disabled={i === tables.length - 1}
                          onClick={() => move(i, 1)}
                        >
                          <Icon name="chevronDown" />
                        </button>
                        <button
                          type="button"
                          className="icon bordered danger"
                          aria-label={`Remove table ${i + 1}`}
                          onClick={() => remove(i)}
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <button
        type="button"
        className="add"
        onClick={() => {
          onChange([...tables, { id: '', columns: [] }]);
          onSelect(tables.length);
        }}
      >
        Add table
      </button>
      {current && (
        <section
          className="table-config"
          role="group"
          aria-label={current.id ? `Table ${current.id}` : `Table ${selected + 1}`}
        >
          {render(current, selected)}
        </section>
      )}
    </div>
  );
}
