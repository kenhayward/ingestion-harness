import { useState } from 'react';
import { outputCoverage, type ModelChoice, type OutputCoverage } from '@ih/shared';
import { Icon } from '../ui/Icon.js';
import { ModelPicker } from '../ui/ModelPicker.js';
import { sectionTone, TONE_COLOR } from '../ui/stageStyle.js';
import { StepFigures } from '../workbench/StepsView.js';
import type { StepMetric } from '../workbench/steps.js';
import { repeatNote, stepListSummary, type SectionLike } from './editor-derive.js';
import { Area, intList, opt, optInt, Text } from './fields.js';
import { CheckStep, ContextEditor, RepeatKeyColumn } from './StepForms.js';
import { moveItem, removeAt, setIn, type Definition } from './model.js';

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const sectionDefsOf = (definition: Definition): SectionLike[] => {
  const sections = (definition.document as Definition | undefined)?.sections;
  return Array.isArray(sections)
    ? sections.filter((s): s is SectionLike => !!s && typeof (s as SectionLike).id === 'string')
    : [];
};
const tableColumnsOf = (definition: Definition): Record<string, string[]> => {
  const tables = (definition.outputs as Definition | undefined)?.tables;
  return Object.fromEntries(
    (Array.isArray(tables) ? tables : [])
      .filter((t): t is Definition => !!t && typeof (t as Definition).id === 'string')
      .map((t) => [t.id as string, idsOf(t.columns)]),
  );
};
const idsOf = (v: unknown): string[] =>
  Array.isArray(v) ? ids(v.map((x) => (x as { id?: unknown })?.id)) : [];
/** Each section's anchor by id, so a step's Reads list says where each section starts. */
const anchorsOf = (v: unknown): ReadonlyMap<string, string> =>
  new Map(
    (Array.isArray(v) ? v : []).flatMap((x) => {
      const { id, anchor } = (x ?? {}) as { id?: unknown; anchor?: unknown };
      return typeof id === 'string' && typeof anchor === 'string' ? [[id, anchor] as const] : [];
    }),
  );

/**
 * The Template tab's Pipeline (handoff §10): the steps as a list (number, id, what it fills and
 * reads) and the selected step's form. The Templates page keeps its collapsible step cards.
 */
export function PipelineEditor({
  pipeline,
  selected,
  onSelect,
  onChange,
  readOnly,
  definition,
  models,
  typeModelLabel,
  paths,
  metrics,
  resetKey = 0,
}: {
  pipeline: Definition[];
  /** Index of the open step; -1 when there are none. */
  selected: number;
  onSelect: (index: number) => void;
  onChange: (pipeline: Definition[]) => void;
  readOnly: boolean;
  /** The whole draft: its sections, outputs and which step fills what. */
  definition: Definition;
  models: readonly ModelChoice[];
  /** The Model picker's empty option: what a step naming no model runs. */
  typeModelLabel: string;
  /** Values a check step can compare. */
  paths: string[];
  /** Figures from the type's runs, by step id. */
  metrics: ReadonlyMap<string, StepMetric>;
  /** Changes when the draft is replaced from outside (Discard, Reload, YAML): forms start over. */
  resetKey?: number;
}) {
  /** Bumped when a step is removed: the next step slides into the open index. */
  const [removals, setRemovals] = useState(0);
  const add = (step: Definition) => {
    onChange([...pipeline, step]);
    onSelect(pipeline.length);
  };
  const current = selected >= 0 ? pipeline[selected] : undefined;
  return (
    <div className="pipeline-editor">
      <div className="step-list-col">
        <ol className="step-list" aria-label="Pipeline steps">
          {pipeline.map((step, i) => (
            <li key={i}>
              <button
                type="button"
                className="step-list-item"
                aria-pressed={i === selected}
                onClick={() => onSelect(i)}
              >
                <span className="step-num">{i + 1}</span>{' '}
                <span className="mono step-id">
                  {typeof step.id === 'string' && step.id ? step.id : '(no id)'}
                </span>{' '}
                <small className="muted">{stepListSummary(step)}</small>
              </button>
            </li>
          ))}
        </ol>
        <fieldset className="step-list-add" disabled={readOnly}>
          <button
            type="button"
            className="add"
            onClick={() => add({ type: 'extract', id: '', fields: [], sections: [] })}
          >
            Add extract step
          </button>
          <button
            type="button"
            className="add"
            onClick={() => add({ type: 'check', id: '', values: '', reference: '' })}
          >
            Add check step
          </button>
        </fieldset>
      </div>
      {current ? (
        <StepDetail
          // A fresh form per step: the Context editor keeps its own text.
          key={`${selected}:${resetKey}:${removals}`}
          index={selected}
          count={pipeline.length}
          step={current}
          readOnly={readOnly}
          sections={idsOf((definition.document as Definition | undefined)?.sections)}
          sectionDefs={sectionDefsOf(definition)}
          tableColumns={tableColumnsOf(definition)}
          anchors={anchorsOf((definition.document as Definition | undefined)?.sections)}
          fields={idsOf((definition.outputs as Definition | undefined)?.fields)}
          tables={idsOf((definition.outputs as Definition | undefined)?.tables)}
          coverage={outputCoverage(definition)}
          models={models}
          typeModelLabel={typeModelLabel}
          paths={paths}
          metric={typeof current.id === 'string' ? metrics.get(current.id) : undefined}
          onSet={(key, value) => onChange(setIn(pipeline, [selected, key], value))}
          onReplace={(step) => onChange(setIn(pipeline, [selected], step))}
          onMove={(delta) => {
            onChange(moveItem(pipeline, selected, delta));
            onSelect(selected + delta);
          }}
          onRemove={() => {
            onChange(removeAt(pipeline, selected));
            setRemovals((r) => r + 1);
            onSelect(Math.min(selected, pipeline.length - 2));
          }}
        />
      ) : (
        <p className="muted">No steps yet: add one, or ask the model on the Pipeline tab.</p>
      )}
    </div>
  );
}

function StepDetail({
  index,
  count,
  step,
  readOnly,
  sections,
  sectionDefs,
  tableColumns,
  anchors,
  fields,
  tables,
  coverage,
  models,
  typeModelLabel,
  paths,
  metric,
  onSet,
  onReplace,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  step: Definition;
  readOnly: boolean;
  sections: string[];
  sectionDefs: readonly SectionLike[];
  tableColumns: Record<string, string[]>;
  anchors: ReadonlyMap<string, string>;
  fields: string[];
  tables: string[];
  coverage: OutputCoverage;
  models: readonly ModelChoice[];
  typeModelLabel: string;
  paths: string[];
  metric: StepMetric | undefined;
  onSet: (key: string, value: unknown) => void;
  onReplace: (step: Definition) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const kind = step.type === 'check' ? 'CHECK' : 'EXTRACT';
  return (
    <section className="card step-detail" aria-label={`Step ${n}`}>
      <div className="step-detail-head">
        <span className={`kind-tag ${kind === 'CHECK' ? 'tone-neutral' : 'tone-info'}`}>
          {kind}
        </span>
        <h3 className="mono">{typeof step.id === 'string' && step.id ? step.id : '(no id)'}</h3>
        <fieldset className="step-tools" disabled={readOnly}>
          <button
            type="button"
            className="icon bordered"
            aria-label={`Move step ${n} up`}
            disabled={index === 0}
            title={index === 0 ? 'Already the first step' : undefined}
            onClick={() => onMove(-1)}
          >
            <Icon name="chevronUp" />
          </button>
          <button
            type="button"
            className="icon bordered"
            aria-label={`Move step ${n} down`}
            disabled={index === count - 1}
            title={index === count - 1 ? 'Already the last step' : undefined}
            onClick={() => onMove(1)}
          >
            <Icon name="chevronDown" />
          </button>
          <button
            type="button"
            className="icon bordered danger"
            aria-label={`Remove step ${n}`}
            onClick={onRemove}
          >
            <Icon name="trash" />
          </button>
        </fieldset>
      </div>
      <fieldset className="step-body" disabled={readOnly}>
        {step.type === 'check' ? (
          <CheckStep step={step} paths={paths} set={onSet} />
        ) : (
          <ExtractDetail
            step={step}
            sections={sections}
            sectionDefs={sectionDefs}
            tableColumns={tableColumns}
            anchors={anchors}
            fields={fields}
            tables={tables}
            coverage={coverage}
            models={models}
            typeModelLabel={typeModelLabel}
            set={onSet}
            replace={onReplace}
          />
        )}
      </fieldset>
      {step.type !== 'check' && (
        <div className="step-detail-figures">
          <span className="muted">Last runs</span>
          <StepFigures metric={metric} here />
        </div>
      )}
    </section>
  );
}

function ExtractDetail({
  step,
  sections,
  sectionDefs,
  tableColumns,
  anchors,
  fields,
  tables,
  coverage,
  models,
  typeModelLabel,
  set,
  replace,
}: {
  step: Definition;
  sections: string[];
  sectionDefs: readonly SectionLike[];
  tableColumns: Record<string, string[]>;
  anchors: ReadonlyMap<string, string>;
  fields: string[];
  tables: string[];
  coverage: OutputCoverage;
  models: readonly ModelChoice[];
  typeModelLabel: string;
  set: (key: string, value: unknown) => void;
  replace: (step: Definition) => void;
}) {
  const repeat = repeatNote(step, sectionDefs);
  const isTable = typeof step.table === 'string';
  const filled = isTable ? [step.table as string] : ids(step.fields);
  const reads = ids(step.sections);
  const filledBy = (id: string) => coverage.outputs.find((o) => o.id === id)?.steps ?? [];
  const candidates = isTable ? [] : fields.filter((f) => !filled.includes(f));
  const unfilled = candidates.filter((f) => filledBy(f).length === 0);
  const elsewhere = candidates.filter((f) => filledBy(f).length > 0);
  const tableChoices = !isTable && filled.length === 0 ? tables : [];
  const addBlocked = isTable
    ? 'A table step fills one table: remove it to fill fields instead'
    : candidates.length + tableChoices.length === 0
      ? 'This step already fills every output'
      : null;
  const addOutput = (id: string) => {
    if (tableChoices.includes(id)) replace({ ...step, fields: [], table: id });
    else set('fields', [...filled, id]);
  };
  const removeOutput = (id: string) => {
    if (!isTable)
      return set(
        'fields',
        filled.filter((f) => f !== id),
      );
    const rest = { ...step };
    delete rest.table;
    delete rest.chunkPages;
    replace({ ...rest, fields: [] });
  };
  return (
    <div className="step-detail-body">
      <div className="grid step-settings">
        <Text label="Step id" value={step.id} onChange={(v) => set('id', v)} />
        <div className="field">
          <span className="field-label">Model</span>
          <ModelPicker
            label="Model"
            choices={models}
            // No model, or `default`: the default choice, whichever it is when the step runs.
            value={step.model === 'default' ? '' : (step.model ?? '')}
            emptyLabel={typeModelLabel}
            onChange={(id) => set('model', id || undefined)}
          />
        </div>
        {isTable && (
          <Text
            label="Pages per call"
            hint="Run once per N pages (large tables); empty: all pages in one call"
            placeholder="all"
            value={step.chunkPages === undefined ? '' : String(step.chunkPages)}
            onChange={(v) => set('chunkPages', optInt(v))}
          />
        )}
        <Text
          label="Max attempts"
          value={step.maxAttempts === undefined ? '' : String(step.maxAttempts)}
          onChange={(v) => set('maxAttempts', optInt(v))}
        />
      </div>
      <fieldset className="section-checks">
        <legend>Reads sections</legend>
        {sections.length === 0 ? (
          <small>No sections defined yet.</small>
        ) : (
          <ul className="section-check-list">
            {sections.map((id, i) => (
              <li key={id}>
                <label className="section-check" title={repeat.disabled[id]}>
                  <input
                    type="checkbox"
                    checked={reads.includes(id)}
                    disabled={repeat.disabled[id] !== undefined && !reads.includes(id)}
                    onChange={(e) =>
                      set(
                        'sections',
                        e.target.checked ? [...reads, id] : reads.filter((s) => s !== id),
                      )
                    }
                  />
                  <span
                    className="section-dot"
                    aria-hidden="true"
                    style={{ background: TONE_COLOR[sectionTone(i)] }}
                  />
                  <code>{id}</code>
                  {sectionDefs.find((s) => s.id === id)?.repeat && (
                    <small className="muted"> repeats</small>
                  )}
                </label>
                {anchors.get(id) && (
                  <code className="section-anchor muted" title="Anchor: where this section starts">
                    {anchors.get(id)}
                  </code>
                )}
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <RepeatKeyColumn
        step={step}
        sectionDefs={sectionDefs}
        columns={tableColumns[step.table as string] ?? []}
        set={set}
      />
      <fieldset className="fill-chips">
        <legend>Fills outputs</legend>
        {filled.map((id) => (
          <span key={id} className="fill-chip">
            <code>{id}</code>
            <button
              type="button"
              className="icon"
              aria-label={`Stop filling ${id}`}
              onClick={() => removeOutput(id)}
            >
              ×
            </button>
          </span>
        ))}
        <select
          aria-label="Add output"
          value=""
          disabled={addBlocked !== null}
          title={addBlocked ?? undefined}
          onChange={(e) => {
            if (e.target.value) addOutput(e.target.value);
          }}
        >
          <option value="">+ Add output…</option>
          {unfilled.length > 0 && (
            <optgroup label="Not filled by any step">
              {unfilled.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </optgroup>
          )}
          {elsewhere.length > 0 && (
            <optgroup label="Filled by another step">
              {elsewhere.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </optgroup>
          )}
          {tableChoices.length > 0 && (
            <optgroup label="Tables">
              {tableChoices.map((t) => (
                <option key={t} value={t}>
                  {t} (table)
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </fieldset>
      <Area
        label="Instructions"
        hint="Added to the preamble for this step only."
        value={step.instructions}
        onChange={(v) => set('instructions', opt(v))}
      />
      <details className="step-more">
        <summary>More settings</summary>
        <div className="grid">
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
        </div>
        <ContextEditor
          value={step.context ?? {}}
          onChange={(context) => set('context', Object.keys(context).length ? context : undefined)}
        />
      </details>
    </div>
  );
}
