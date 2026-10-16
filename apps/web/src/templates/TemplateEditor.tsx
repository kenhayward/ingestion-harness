import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import {
  describeDefinitionChange,
  VALUE_TYPES,
  type DataPolicy,
  type DeliveryFormat,
  type JobSummary,
  type OverviewItem,
  type Retirement,
} from '@ih/shared';
import { ApiError, type Api, type TemplateRecordView } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { keepDraft, loadKept } from '../ui/keptDraft.js';
import { RETIRED_REASON } from '../ui/retired.js';
import { RetiredBanner } from '../ui/RetiredBanner.js';
import { YamlEditor } from '../ui/YamlEditor.js';
import { keyFromOptions } from '../workbench/segmentation.js';
import { TabHeader } from '../workbench/TabHeader.js';
import { EditorHeader } from './EditorHeader.js';
import { ChecksPanel } from './ChecksPanel.js';
import { DraftChangesPanel } from './DraftChangesPanel.js';
import { EmbeddedHeader } from './EmbeddedHeader.js';
import { attentionTabs, issueText, templateChecks, type SubTab } from './checks.js';
import { publishBlocker, rowTableMinWidth, tabCounts, unsavedText } from './editor-derive.js';
import { PipelineEditor } from './PipelineEditor.js';
import type { StepMetric } from '../workbench/steps.js';
import { StepCard } from './StepCard.js';
import { TestRail } from './TestRail.js';
import { QualityPanel } from './QualityPanel.js';
import { UnsavedBar } from './UnsavedBar.js';
import { VersionsPanel } from './VersionsPanel.js';
import {
  checkPathOptions,
  getIn,
  moveItem,
  removeAt,
  setIn,
  validateDefinition,
  type Definition,
} from './model.js';
import { choiceName } from '../jobs/derive.js';
import { ModelPicker, useModelChoices } from '../ui/ModelPicker.js';
import { Area, opt, Select, Text } from './fields.js';
import { MappingEditor } from './MappingEditor.js';
import { CheckStep, defaultLabel, ExtractStep } from './StepForms.js';

type Path = (string | number)[];
type Tab =
  'general' | 'sections' | 'outputs' | 'pipeline' | 'mapping' | 'yaml' | 'quality' | 'versions';

/** The Templates page's order (UI handoff §5). */
const STANDALONE_TABS: [Tab, string][] = [
  ['general', 'General'],
  ['sections', 'Sections'],
  ['pipeline', 'Pipeline'],
  ['outputs', 'Outputs'],
  ['mapping', 'Mapping'],
  ['yaml', 'YAML'],
  ['quality', 'Quality'],
  ['versions', 'Versions'],
];

/** The Template tab's order (handoff §10): Evaluate replaces Quality. */
const EMBEDDED_TABS: [Tab, string][] = [
  ['general', 'General'],
  ['sections', 'Sections'],
  ['outputs', 'Outputs'],
  ['pipeline', 'Pipeline'],
  ['mapping', 'Mapping'],
  ['yaml', 'YAML'],
  ['versions', 'Versions'],
];

/** What publishing can deliver (DELIVERY_FORMATS), in that order. */
const FORMATS: [DeliveryFormat, string][] = [
  ['csv', 'CSV'],
  ['json', 'JSON'],
  ['rdf', 'RDF (Turtle)'],
];

/** Kept recipe edits (`ih.recipeDraft.<id>.<version>`): the definition, and unapplied YAML. */
function keptRecipe(value: unknown): { def: Definition; yaml?: string } | null {
  if (!value || typeof value !== 'object') return null;
  const { def, yaml } = value as { def?: unknown; yaml?: unknown };
  if (!def || typeof def !== 'object' || Array.isArray(def)) return null;
  if (yaml !== undefined && typeof yaml !== 'string') return null;
  return { def: def as Definition, ...(yaml !== undefined ? { yaml } : {}) };
}

/** Set when hosted by the Workbench's Template tab (handoff §10). */
export interface EmbeddedEditor {
  /** The draft was published, deleted or a new one started: reload the project. */
  onChanged: () => void;
  /** Saved, or a test run queued: stage states may have moved (reload the page overview). */
  onSaved?: () => void;
  /** The project's data policy, for the Try on model picker (default: local). */
  dataPolicy?: DataPolicy;
  /** The page overview's items (null while unknown): stale stages for Checks. */
  stages?: readonly OverviewItem[] | null;
  /** The overview's Template item: the tab header's status line. */
  item?: OverviewItem | null;
  /** The latest published version: "Changes since vN" and Full diff. */
  published?: number | null;
  /**
   * The project's retirement (D17), from the project page: read-only at once and following its
   * reloads. Absent: the editor looks it up itself.
   */
  retired?: Retirement | null;
}

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
   * Set when hosted by the Workbench's Template tab: the tab header (Try on, Export, More,
   * Publish vN) replaces the editor header, publish goes through the Workbench (`api.publish`: no
   * references or evaluation needed, and the publication is logged), the sub-tabs drop Quality,
   * edits show the unsaved bar, and publish / new draft / delete draft report back instead of
   * navigating to Document types.
   */
  embedded?: EmbeddedEditor;
}) {
  const [view, setView] = useState<TemplateRecordView | null>(null);
  /** Unsaved edits of this draft, kept in this browser (ui/keptDraft.ts). */
  const draftKey = `ih.recipeDraft.${templateId}.${version}`;
  const [def, setDef] = useState<Definition>({});
  const [saved, setSaved] = useState('');
  const [tab, setTab] = useState<Tab>(embedded ? 'pipeline' : 'general');
  const [outputsTab, setOutputsTab] = useState<'fields' | 'tables'>('fields');
  /** The table configured below the Tables list (clamped to the list). */
  const [tableIndex, setTableIndex] = useState(0);
  const [yamlText, setYamlText] = useState('');
  /** YAML typed but not applied: kept when the sub-tab changes, and when leaving the page. */
  const [yamlEdited, setYamlEdited] = useState(false);
  /**
   * The draft's `updatedAt` the edits started from: a save sends it, so edits restored from an
   * earlier visit are refused (409) when the draft was saved again meanwhile, never overwrite it.
   */
  const [editBase, setEditBase] = useState<string | null>(null);
  /** Edits put back from an earlier visit; `stale` when the draft was saved again since. */
  const [restored, setRestored] = useState<{ stale: boolean } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const models = useModelChoices(api);
  const modelName = (id: string) => choiceName(id, models);
  /** The document type's model choice, which steps naming none inherit ('' = the default). */
  const typeModel = typeof def.model === 'string' && def.model !== 'default' ? def.model : '';
  /** The one pipeline step whose card is open (null: all collapsed). */
  const [openStep, setOpenStep] = useState<number | null>(null);
  /** Latest published version of this type, for "from published vN" (null: never published). */
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  /** The type's retirement (D17: read-only); null when active. */
  const [looked, setLooked] = useState<{ retired: Retirement | null } | null>(null);
  /** A save refused with 409 (written elsewhere meanwhile, or published): offer a reload. */
  const [conflict, setConflict] = useState(false);
  /** Counts draft writes by this editor (save, reload), so the change log reloads after each. */
  const [saves, setSaves] = useState(0);
  /** A save is in flight: a second one would carry the same base and be refused as a conflict. */
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const savedDef = useMemo<Definition>(
    () => (saved ? (JSON.parse(saved) as Definition) : {}),
    [saved],
  );

  const accept = (v: TemplateRecordView) => {
    setView(v);
    setDef(v.record.definition);
    setReplaced((r) => r + 1);
    setSaved(JSON.stringify(v.record.definition));
    setEditBase(v.record.updatedAt);
    setYamlEdited(false);
    setRestored(null);
  };
  /** Puts back the edits left unsaved on an earlier visit to this draft. */
  const restore = (v: TemplateRecordView) => {
    if (v.record.status !== 'draft') return;
    const kept = loadKept(draftKey, keptRecipe);
    if (!kept) return;
    setDef(kept.value.def);
    setReplaced((r) => r + 1);
    setEditBase(typeof kept.base === 'string' ? kept.base : null);
    if (kept.value.yaml !== undefined) {
      setYamlText(kept.value.yaml);
      setYamlEdited(true);
    }
    setRestored({ stale: kept.base !== v.record.updatedAt });
  };

  useEffect(() => {
    api.getTemplate(templateId, version).then(
      (v) => {
        accept(v);
        restore(v);
      },
      (err: Error) => setError(err.message),
    );
    api.listTemplates().then(
      (items) => {
        const item = items.find((t) => t.id === templateId);
        setPublishedVersion(item?.published ?? null);
        setLooked({ retired: item?.retired ?? null });
      },
      () => {
        setPublishedVersion(null);
        setLooked({ retired: null });
      },
    );
    // accept and restore only set state; restore's key is made of templateId and version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, templateId, version]);

  /** The open step on the Recipe tab's Pipeline (clamped to the list when rendered). */
  const [selectedStep, setSelectedStep] = useState(0);
  /** Bumped when the draft is replaced wholesale, so open step forms drop their local text. */
  const [replaced, setReplaced] = useState(0);
  const [metrics, setMetrics] = useState<ReadonlyMap<string, StepMetric>>(new Map());
  // `embedded` is a new object on every render: depend on whether it is set.
  const isEmbedded = embedded !== undefined;
  useEffect(() => {
    if (!isEmbedded) return;
    let live = true;
    api.getMetrics(templateId).then(
      (m) => {
        if (live) setMetrics(new Map(m.steps.map((s) => [s.stepId, s])));
      },
      () => {}, // figures are optional: the form works without them
    );
    return () => {
      live = false;
    };
  }, [api, templateId, isEmbedded]);

  // Keep unsaved edits (and unapplied YAML) of a draft in this browser while there are any.
  const draftOpen = view?.record.status === 'draft';
  const defJson = JSON.stringify(def);
  useEffect(() => {
    if (!draftOpen) return;
    const changed = defJson !== saved;
    keepDraft(
      draftKey,
      changed || yamlEdited
        ? {
            base: editBase,
            value: {
              def: JSON.parse(defJson) as Definition,
              ...(yamlEdited ? { yaml: yamlText } : {}),
            },
          }
        : null,
    );
  }, [draftKey, draftOpen, defJson, saved, yamlEdited, yamlText, editBase]);

  const issues = useMemo(() => validateDefinition(def), [def]);
  /** The type's retirement: the project page's when embedded, else the lookup (null: active). */
  const retired = embedded?.retired !== undefined ? embedded.retired : (looked?.retired ?? null);
  /** Until the retirement is known the recipe is not editable (a retired one never flashes open). */
  const retirementKnown = embedded?.retired !== undefined || looked !== null;

  if (!view) {
    const body = error ? <p role="alert">{error}</p> : <p>Loading…</p>;
    return embedded ? (
      <section className="template-editor template-embedded">
        <TabHeader
          title={`Transformation recipe · draft v${version}`}
          item={embedded.item ?? null}
        />
        {body}
      </section>
    ) : (
      body
    );
  }

  const { record } = view;
  /** A retired type's recipe is read-only, like a published version (D17). */
  const editable = record.status === 'draft' && retirementKnown && retired === null;
  /** Why nothing new may run: a retired document type (null when active). */
  const blockedBy = retired ? RETIRED_REASON : null;
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

  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      accept(await api.saveTemplate(templateId, version, def, editBase || undefined));
      setMessage('Draft saved.');
      setSaves((n) => n + 1);
      embedded?.onSaved?.();
    } catch (err) {
      setError((err as Error).message);
      setConflict(err instanceof ApiError && err.status === 409);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const reload = () =>
    act(async () => {
      accept(await api.getTemplate(templateId, version));
      setConflict(false);
      setSaves((n) => n + 1);
      setMessage('Reloaded the saved draft.');
    });
  const discard = () => {
    setDef(savedDef);
    setReplaced((r) => r + 1);
    setEditBase(record.updatedAt);
    setYamlEdited(false);
    setRestored(null);
    if (tab === 'yaml') setYamlText(toYaml(savedDef, { lineWidth: 100 }));
    setMessage(null);
    setError(null);
    setConflict(false);
  };
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
    if (t === 'yaml' && !yamlEdited) setYamlText(toYaml(def, { lineWidth: 100 }));
    setTab(t);
  };
  const applyYaml = () => {
    try {
      const parsed = parseYaml(yamlText);
      if (!parsed || typeof parsed !== 'object') throw new Error('YAML must be a mapping');
      setDef({ ...(parsed as Definition), id: templateId, version });
      setReplaced((r) => r + 1);
      setYamlEdited(false);
      setMessage('YAML applied (not saved yet).');
    } catch (err) {
      setError(`YAML: ${(err as Error).message}`);
    }
  };

  const sections: { id: string }[] = def.document?.sections ?? [];
  const fields: { id: string }[] = def.outputs?.fields ?? [];
  const tables: { id: string; columns?: { id: string }[] }[] = def.outputs?.tables ?? [];
  const pipeline: Definition[] = def.pipeline ?? [];
  const paths = checkPathOptions(def);
  const counts = tabCounts(def);
  const tabs = embedded ? EMBEDDED_TABS : STANDALONE_TABS;
  const tabCount = (t: Tab): string | null =>
    t === 'sections'
      ? String(counts.sections)
      : t === 'outputs'
        ? embedded
          ? String(counts.fields + counts.tables)
          : `${counts.fields} · ${counts.tables}`
        : t === 'pipeline'
          ? String(counts.steps)
          : null;
  const checks = embedded
    ? templateChecks({
        projectId: templateId,
        definition: def,
        issues,
        serverIssues: dirty
          ? []
          : view.issues.filter((i) => i.severity !== 'warning').map(issueText),
        serverWarnings: dirty
          ? []
          : view.issues.filter((i) => i.severity === 'warning').map(issueText),
        stages: embedded.stages ?? null,
      })
    : [];
  const needs = attentionTabs(checks);
  /** The Template tab ends each part with the stage that drafts it (handoff §10). */
  const stageLink = (stage: string, text: string) =>
    embedded ? (
      <p className="muted subtab-foot">
        <a href={`#/workbench/${templateId}/${stage}`}>{text}</a>
      </p>
    ) : null;

  return (
    <section className={embedded ? 'template-editor template-embedded' : 'template-editor'}>
      {embedded ? (
        <EmbeddedHeader
          api={api}
          templateId={templateId}
          version={version}
          status={record.status}
          dirty={dirty}
          dataPolicy={embedded.dataPolicy ?? 'local'}
          issues={issues.length}
          item={embedded.item ?? null}
          exportUrl={api.exportUrl(templateId, version)}
          publishBlocker={publishBlocker(dirty, issues.length, retired !== null)}
          retired={blockedBy}
          onQueued={() => embedded.onSaved?.()}
          onPublish={() => void publish()}
          onNewDraft={() => void newDraft()}
          onDeleteDraft={() => void removeDraft()}
        />
      ) : (
        <EditorHeader
          name={String(def.name ?? templateId)}
          id={templateId}
          version={version}
          status={record.status}
          publishedVersion={publishedVersion}
          dirty={dirty}
          issues={issues.length}
          exportUrl={api.exportUrl(templateId, version)}
          saving={saving}
          retired={retired !== null}
          onSave={() => void save()}
          onPublish={() => void publish()}
          onNewDraft={() => void newDraft()}
          onDeleteDraft={() => void removeDraft()}
        />
      )}
      {!embedded && retired && <RetiredBanner retirement={retired} typeId={templateId} />}
      {restored && (dirty || yamlEdited) && (
        <p role="status" className="kept-note">
          <Icon name="info" size={14} />
          {restored.stale
            ? 'Restored your unsaved changes from your last visit, but the draft was saved again since: saving them will be refused. Note what you need, then reload the draft.'
            : 'Restored your unsaved changes from your last visit.'}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert">
          {error}
          {conflict && (
            <>
              {' '}
              <button type="button" onClick={() => void reload()}>
                Reload the draft
              </button>
            </>
          )}
        </p>
      )}
      {!embedded && issues.length > 0 && (
        <ul aria-label="Validation issues" className="issues">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}

      {embedded && (
        // Above the sub-tabs, so the editor below keeps the full width (wide Outputs tables).
        <aside className="template-side" aria-label="Checks and changes">
          <ChecksPanel checks={checks} onOpenSubTab={(t) => openTab(t)} />
          {record.status === 'draft' && (
            <DraftChangesPanel
              api={api}
              projectId={templateId}
              version={version}
              published={embedded.published ?? null}
              refreshKey={saves}
            />
          )}
        </aside>
      )}
      <div className="editor-layout">
        <div className="editor-main">
          <div role="tablist" aria-label="Template sections">
            {tabs.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => openTab(id)}>
                {label}
                {tabCount(id) && (
                  <>
                    {' '}
                    <span className="tab-count">{tabCount(id)}</span>
                  </>
                )}
                {needs.has(id as SubTab) && (
                  <>
                    <span className="tab-dot" aria-hidden="true" />
                    <span className="visually-hidden"> (needs attention)</span>
                  </>
                )}
              </button>
            ))}
          </div>

          {tab === 'quality' && !embedded && (
            <QualityPanel api={api} templateId={templateId} version={version} retired={blockedBy} />
          )}

          {tab === 'versions' && (
            // Outside the fieldset: published versions take labels too (#144).
            <VersionsPanel
              api={api}
              templateId={templateId}
              openVersion={version}
              openUpdatedAt={record.status === 'draft' ? record.updatedAt : null}
              dirty={dirty || yamlEdited}
              retired={blockedBy}
              refreshKey={saves}
              onRestored={(draft) => {
                if (draft.record.version === version) accept(draft);
                setSaves((n) => n + 1);
                setMessage(`Draft v${draft.record.version} replaced (not published yet).`);
                embedded?.onChanged();
              }}
              onStarted={(draft) => {
                if (embedded) return embedded.onChanged();
                onNavigate(`#/templates/${draft.record.id}/${draft.record.version}`);
              }}
            />
          )}

          <fieldset disabled={!editable} className="editor-body">
            {tab === 'general' && (
              <>
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
                  <fieldset className="formats">
                    <legend>Delivered formats</legend>
                    {FORMATS.map(([format, label]) => {
                      const formats: DeliveryFormat[] = def.delivery?.formats ?? ['csv', 'json'];
                      const on = formats.includes(format);
                      const noMapping = format === 'rdf' && !def.semantics && !on;
                      return (
                        <label key={format}>
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={noMapping || (on && formats.length === 1)}
                            onChange={() => {
                              const next = FORMATS.map(([f]) => f).filter((f) =>
                                f === format ? !on : formats.includes(f),
                              );
                              const isDefault = next.join() === 'csv,json';
                              update(['delivery'], isDefault ? undefined : { formats: next });
                            }}
                          />
                          {label}
                        </label>
                      );
                    })}
                    {!def.semantics && (
                      <p className="muted">
                        Add an ontology mapping on the Mapping tab to deliver RDF.
                      </p>
                    )}
                  </fieldset>
                </div>
                {stageLink('revise', 'Revise proposes a new preamble from your feedback')}
              </>
            )}

            {tab === 'sections' && (
              <>
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
                  detail={(s, i) => {
                    const repeats = getIn(s, ['repeat']) === true;
                    return (
                      <div
                        className="section-repeat"
                        role="group"
                        aria-label={`Section ${i + 1} repeating`}
                      >
                        <label className="section-repeat-toggle">
                          <input
                            type="checkbox"
                            aria-label={`Section ${i + 1} repeats`}
                            checked={repeats}
                            onChange={(e) => {
                              if (e.target.checked) {
                                update(['document', 'sections', i, 'repeat'], true);
                                return;
                              }
                              const rest = Object.fromEntries(
                                Object.entries(s as Record<string, unknown>).filter(
                                  ([k]) => !['repeat', 'key', 'keyFrom'].includes(k),
                                ),
                              );
                              update(['document', 'sections', i], rest);
                            }}
                          />
                          <span>
                            <strong>Repeats</strong>
                            <small className="muted">
                              every match of the anchor starts an occurrence (one per batch, for
                              example)
                            </small>
                          </span>
                        </label>
                        {repeats && (
                          <>
                            <label className="section-repeat-field">
                              <span>Key</span>
                              <input
                                className="code"
                                aria-label={`Section ${i + 1} key`}
                                placeholder="e.g. Batch\s+(\w+)"
                                value={getIn(s, ['key']) ?? ''}
                                onChange={(e) =>
                                  update(
                                    ['document', 'sections', i, 'key'],
                                    e.target.value || undefined,
                                  )
                                }
                              />
                              <small className="muted">
                                names each occurrence: a regex read from its own text (group 1)
                              </small>
                            </label>
                            <label className="section-repeat-field">
                              <span>Key from</span>
                              <select
                                aria-label={`Section ${i + 1} key from`}
                                value={getIn(s, ['keyFrom']) ?? ''}
                                onChange={(e) =>
                                  update(
                                    ['document', 'sections', i, 'keyFrom'],
                                    e.target.value || undefined,
                                  )
                                }
                              >
                                <option value="">None</option>
                                {keyFromOptions(sections, getIn(s, ['id'])).map((id) => (
                                  <option key={id} value={id}>
                                    {id}
                                  </option>
                                ))}
                              </select>
                              <small className="muted">
                                takes another repeating section's key (the batch heading above) when
                                its own key finds none; lists repeating sections with a key
                              </small>
                            </label>
                          </>
                        )}
                      </div>
                    );
                  }}
                />
                {stageLink('sections', 'Ask the model in Sections')}
              </>
            )}

            {tab === 'mapping' && (
              <MappingEditor
                api={api}
                definition={def}
                semantics={def.semantics}
                onChange={(next) => update(['semantics'], next)}
                preview={embedded ? { projectId: templateId, dirty } : undefined}
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
                {stageLink('outputs', 'Ask the model in Outputs')}
              </>
            )}

            {tab === 'yaml' && (
              <div className="yaml">
                <YamlEditor
                  label="Recipe YAML"
                  value={yamlText}
                  onChange={(text) => {
                    setYamlText(text);
                    setYamlEdited(true);
                  }}
                  readOnly={!editable}
                />
                <button type="button" onClick={applyYaml}>
                  Apply YAML
                </button>
              </div>
            )}
          </fieldset>
          {/* Outside the disabled fieldset: a published version's steps still open (read-only). */}
          {tab === 'pipeline' && embedded && (
            <PipelineEditor
              pipeline={pipeline}
              // -1 only when there are no steps (removing the last one leaves -1 behind).
              selected={
                pipeline.length === 0
                  ? -1
                  : Math.min(Math.max(selectedStep, 0), pipeline.length - 1)
              }
              onSelect={setSelectedStep}
              onChange={(next) => update(['pipeline'], next)}
              readOnly={!editable}
              definition={def}
              models={models}
              typeModelLabel={
                typeModel
                  ? `Document type's model (${modelName(typeModel)})`
                  : `Default choice${defaultLabel(models)}`
              }
              paths={paths}
              metrics={metrics}
              resetKey={replaced}
            />
          )}
          {tab === 'pipeline' && !embedded && (
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
                      sectionDefs={sections}
                      tableColumns={Object.fromEntries(
                        tables.map((t) => [
                          t.id,
                          (t.columns ?? []).map((c: { id: string }) => c.id),
                        ]),
                      )}
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
          {tab === 'pipeline' && stageLink('steps', 'Ask the model in Steps')}
        </div>
        {!embedded && (
          <TestRail
            api={api}
            templateId={templateId}
            version={version}
            jobs={jobs}
            typeModel={typeModel ? { model: typeModel } : {}}
            retired={blockedBy}
          />
        )}
      </div>
      {embedded && editable && dirty && (
        <UnsavedBar
          text={unsavedText(describeDefinitionChange(savedDef, def).subjects)}
          version={version}
          onDiscard={discard}
          saving={saving}
          onSave={() => void save()}
        />
      )}
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
        [`${heading} ID`, '12rem'],
        ['Name', '12rem'],
        ['Type', '7rem'],
        ['Enum values', '10rem'],
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
  detail,
}: {
  label: string;
  noun: string;
  addLabel?: string;
  columns: [heading: string, width: string | undefined][];
  items: T[];
  onChange: (items: T[]) => void;
  create: () => T;
  cells: (item: T, index: number) => ReactNode[];
  /** A second line under each item, across its columns (settings with no column of their own). */
  detail?: (item: T, index: number) => ReactNode;
}) {
  return (
    <div className="row-table">
      <table aria-label={label} style={{ minWidth: rowTableMinWidth(columns) }}>
        <thead>
          <tr>
            <th style={{ width: '2.5rem' }}>#</th>
            {columns.map(([heading, width]) => (
              <th key={heading} style={{ width }}>
                {heading}
              </th>
            ))}
            <th style={{ width: '9rem' }} />
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <Fragment key={i}>
              <tr className={detail ? 'has-detail' : undefined}>
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
              {detail && (
                <tr className="row-detail">
                  <td />
                  <td colSpan={columns.length + 1}>{detail(item, i)}</td>
                </tr>
              )}
            </Fragment>
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
                <th style={{ width: '2.5rem' }}>#</th>
                <th>Table ID</th>
                <th style={{ width: '35%' }}>Name</th>
                <th style={{ width: '8rem' }}>Columns</th>
                <th style={{ width: '9rem' }}>
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
