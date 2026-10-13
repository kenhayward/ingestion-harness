import { useState } from 'react';
import type { ModelChoice } from '@ih/shared';
import { ModelPicker } from '../ui/ModelPicker.js';
import { Segmented } from '../ui/Segmented.js';
import { Area, Checklist, intList, opt, optInt, Select, Text } from './fields.js';
import type { Definition } from './model.js';

const FILLS = [
  { value: 'fields', label: 'Fields' },
  { value: 'table', label: 'A table' },
] as const;

/** ` (Main Production Model)`: the default choice's label, when there is one. */
export const defaultLabel = (models: readonly ModelChoice[]) => {
  const choice = models.find((m) => m.isDefault);
  return choice ? ` (${choice.label})` : '';
};

export function ExtractStep({
  step,
  fields,
  tables,
  sections,
  models,
  typeModelLabel,
  set,
  replace,
}: {
  step: Definition;
  fields: string[];
  tables: string[];
  sections: string[];
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
          onToggle={(id, on) => toggle('sections', id, on)}
        />
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

export function CheckStep({
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
