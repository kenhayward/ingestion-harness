import { useState } from 'react';
import type { ModelChoice, PluginInfo } from '@ih/shared';
import { ModelPicker } from '../ui/ModelPicker.js';
import { Segmented } from '../ui/Segmented.js';
import { Area, Checklist, intList, opt, optInt, Select, Text } from './fields.js';
import type { Definition } from './model.js';
import { repeatNote, type SectionLike } from './editor-derive.js';
import { JsonSettings, SettingsForm } from './PluginForms.js';

const FILLS = [
  { value: 'fields', label: 'Fields' },
  { value: 'table', label: 'A table' },
] as const;

/** ` (Main Production Model)`: the default choice's label, when there is one. */
export const defaultLabel = (models: readonly ModelChoice[]) => {
  const choice = models.find((m) => m.isDefault);
  return choice ? ` (${choice.label})` : '';
};

/** A step reading a repeating section (spec 2026-10-16): what runs once per occurrence, and the
 * table column the worker fills with each occurrence's key. */
export function RepeatKeyColumn({
  step,
  sectionDefs,
  columns,
  set,
}: {
  step: Definition;
  sectionDefs: readonly SectionLike[];
  /** The step's table's columns. */
  columns: string[];
  set: (key: string, value: unknown) => void;
}) {
  const { note, keyColumnReason } = repeatNote(step, sectionDefs);
  if (!note) return null;
  return (
    <div className="repeat-key-column">
      <p className="muted">{note}</p>
      <label className="field">
        <span className="field-label">Key column</span>
        <select
          aria-label="Key column"
          value={typeof step.keyColumn === 'string' ? step.keyColumn : ''}
          disabled={keyColumnReason !== null}
          title={keyColumnReason ?? "Filled with each occurrence's key"}
          onChange={(e) => set('keyColumn', e.target.value || undefined)}
        >
          <option value="">None</option>
          {columns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

const OCCURRENCE_MODES = [
  { value: 'all', label: 'All' },
  { value: 'match', label: 'Only those whose heading matches' },
] as const;

/** The pattern of a step's occurrence filter (`occurrences: {match}`), or null without one. */
export const occurrenceMatch = (step: Definition): string | null => {
  const filter = step.occurrences as { match?: unknown } | undefined;
  if (filter === undefined) return null;
  return typeof filter?.match === 'string' ? filter.match : '';
};

/** A step reading a repeating section: every occurrence, or only those whose heading matches a
 * pattern (`occurrences: {match}`). All drops the key; an empty pattern leaves it out too. */
export function OccurrenceFilter({
  step,
  sectionDefs,
  replace,
}: {
  step: Definition;
  sectionDefs: readonly SectionLike[];
  replace: (step: Definition) => void;
}) {
  const match = occurrenceMatch(step);
  // Only, before a pattern is typed: nothing is stored yet, so the form remembers the choice.
  const [only, setOnly] = useState(match !== null);
  const { note } = repeatNote(step, sectionDefs);
  // Shown while set too, so a filter left on a step that no longer repeats can be taken off.
  if (!note && match === null) return null;
  const mode = match !== null || only ? 'match' : 'all';
  const setMatch = (value: string) => {
    // Absent, never an empty pattern.
    const next: Definition = { ...step };
    if (value === '') delete next.occurrences;
    else next.occurrences = { match: value };
    replace(next);
  };
  return (
    <div className="occurrence-filter">
      <div className="field">
        <span className="field-label">Occurrences</span>
        <Segmented
          label="Occurrences"
          options={OCCURRENCE_MODES}
          value={mode}
          onChange={(v) => {
            setOnly(v === 'match');
            if (v === 'all' && match !== null) setMatch('');
          }}
        />
      </div>
      {mode === 'match' && (
        <label className="field">
          <span className="field-label">Heading pattern</span>
          <input
            aria-label="Heading pattern"
            className="mono"
            placeholder="e.g. Appearance"
            value={match ?? ''}
            onChange={(e) => setMatch(e.target.value)}
          />
          <small className="muted">
            Searched in the first lines of each occurrence, ignoring case and line breaks.
          </small>
        </label>
      )}
    </div>
  );
}

/** A table step's columns when it enriches the rows an earlier step created (P4): none ticked,
 * the step creates the rows; ticked, it fills only those columns. */
export function EnrichColumns({
  step,
  columns,
  set,
}: {
  step: Definition;
  /** The step's table's columns. */
  columns: string[];
  set: (key: string, value: unknown) => void;
}) {
  if (typeof step.table !== 'string' || columns.length === 0) return null;
  const enriched = Array.isArray(step.columns)
    ? step.columns.filter((c): c is string => typeof c === 'string')
    : [];
  return (
    <fieldset className="section-checks">
      <legend>Enriches only these columns</legend>
      <ul className="section-check-list">
        {columns.map((c) => (
          <li key={c}>
            <label className="section-check">
              <input
                type="checkbox"
                checked={enriched.includes(c)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...enriched, c]
                    : enriched.filter((x) => x !== c);
                  set('columns', next.length > 0 ? next : undefined);
                }}
              />
              <code>{c}</code>
            </label>
          </li>
        ))}
      </ul>
      <small className="muted">
        None ticked: this step creates the table&apos;s rows. Ticked: it fills only those columns of
        the rows an earlier step created.
      </small>
    </fieldset>
  );
}

export function ExtractStep({
  step,
  fields,
  tables,
  sections,
  sectionDefs = [],
  tableColumns = {},
  models,
  typeModelLabel,
  set,
  replace,
}: {
  step: Definition;
  fields: string[];
  tables: string[];
  sections: string[];
  /** The recipe's sections with their repeat keys (repeating sections). */
  sectionDefs?: readonly SectionLike[];
  /** Each table's column ids. */
  tableColumns?: Record<string, string[]>;
  models: readonly ModelChoice[];
  /** The empty option: what a step naming no model inherits. */
  typeModelLabel: string;
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
        <div className="field">
          <span className="field-label">Fills</span>
          <Segmented
            label="Fills"
            options={FILLS}
            value={fillsTable ? 'table' : 'fields'}
            onChange={(v) => {
              if (v === (fillsTable ? 'table' : 'fields')) return;
              if (v === 'table') {
                replace({ ...step, fields: [], table: tables[0] ?? '' });
              } else {
                const rest = { ...step };
                delete rest.table;
                delete rest.chunkPages;
                delete rest.columns;
                replace({ ...rest, fields: [] });
              }
            }}
          />
        </div>
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
          disabled={repeatNote(step, sectionDefs).disabled}
          onToggle={(id, on) => toggle('sections', id, on)}
        />
        <RepeatKeyColumn
          step={step}
          sectionDefs={sectionDefs}
          columns={tableColumns[step.table as string] ?? []}
          set={set}
        />
        <OccurrenceFilter step={step} sectionDefs={sectionDefs} replace={replace} />
        <EnrichColumns step={step} columns={tableColumns[step.table as string] ?? []} set={set} />
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
export function ContextEditor({
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

const COMPARES = [
  { value: 'reference', label: 'A reference' },
  { value: 'plugin', label: 'A plugin' },
] as const;

/**
 * A check step: the values it judges, and what it compares them with: a reference (another
 * output's values) or a check plugin with its settings.
 */
export function CheckStep({
  step,
  paths,
  plugins = [],
  set,
  replace,
}: {
  step: Definition;
  paths: string[];
  /** The plugin catalogue; a check offers its check plugins. */
  plugins?: readonly PluginInfo[];
  set: (key: string, value: unknown) => void;
  replace: (step: Definition) => void;
}) {
  const checkPlugins = plugins.filter((p) => p.kind === 'check');
  const byPlugin = typeof step.uses === 'string';
  const uses = byPlugin ? String(step.uses) : '';
  const plugin = checkPlugins.find((p) => p.ref === uses);
  const settings = (step.with ?? {}) as Record<string, unknown>;
  const setSettings = (next: Record<string, unknown>) =>
    set('with', Object.keys(next).length > 0 ? next : undefined);
  const noPlugins = !byPlugin && checkPlugins.length === 0;
  return (
    <div className="grid">
      <Text label="Check id" value={step.id} onChange={(v) => set('id', v)} />
      <Select
        label="Values"
        value={step.values}
        options={paths}
        onChange={(v) => set('values', v)}
      />
      <div className="field">
        <span className="field-label">Compares with</span>
        <Segmented
          label="Compares with"
          options={COMPARES}
          value={byPlugin ? 'plugin' : 'reference'}
          disabled={noPlugins}
          title={noPlugins ? 'No check plugins yet: no worker has published any' : undefined}
          onChange={(v) => {
            if (v === (byPlugin ? 'plugin' : 'reference')) return;
            // The two ways exclude each other: leaving one drops its keys.
            const next: Definition = { ...step };
            if (v === 'plugin') {
              delete next.reference;
              delete next.aliases;
              delete next.maxDistance;
              next.uses = checkPlugins[0]?.ref ?? '';
            } else {
              delete next.uses;
              delete next.with;
              next.reference = paths[0] ?? '';
            }
            replace(next);
          }}
        />
      </div>
      {byPlugin ? (
        <>
          <label>
            Check plugin
            <select
              aria-label="Check plugin"
              value={uses}
              onChange={(e) => {
                const next: Definition = { ...step, uses: e.target.value };
                delete next.with; // settings belong to a plugin
                replace(next);
              }}
            >
              {!plugin && (
                <option
                  value={uses}
                >{`${uses || '(none)'} (not on this deployment's workers)`}</option>
              )}
              {checkPlugins.map((p) => (
                <option key={p.ref} value={p.ref}>
                  {p.ref}
                </option>
              ))}
            </select>
            {plugin && <small className="muted">{plugin.summary}</small>}
          </label>
          <fieldset className="plugin-settings">
            <legend>Settings</legend>
            {plugin ? (
              <SettingsForm
                schema={plugin.settingsSchema}
                value={settings}
                onChange={setSettings}
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
        </>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
