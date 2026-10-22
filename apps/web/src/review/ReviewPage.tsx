import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { EditRequest, JobSummary, Role, StepRun } from '@ih/shared';
import { modelDisplayName } from '../jobs/derive.js';
import type { Api, ReviewData } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { DecisionBar } from './DecisionBar.js';
import { EditableValue } from './EditableValue.js';
import { FieldsGrid } from './FieldsGrid.js';
import { GraphTab } from './GraphTab.js';
import { display, effectiveView } from './effective.js';
import { PageViewer } from './PageViewer.js';
import { flaggedTargets, targetKey, type FlagTarget } from './queue.js';
import {
  clampWidth,
  DOC_WIDTH_PRESETS,
  DOC_WIDTH_STEP,
  loadLayout,
  MAX_DOC_WIDTH,
  MIN_DOC_WIDTH,
  saveLayout,
  splitName,
  type ReviewLayout,
} from './layout.js';
import { ReviewHeader } from './ReviewHeader.js';
import { useModelChoices } from '../ui/ModelPicker.js';
import { ReprocessDialog } from '../ui/ReprocessDialog.js';
import { usePlugins } from '../templates/PluginForms.js';
import { StepAttemptsDialog } from '../templates/StepAttemptsDialog.js';

const REVIEWER_KEY = 'ih.reviewer';

/** "3, 59" -> [3, 59] (positive integers only). */
const pageList = (text: string): number[] =>
  text
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

function loadReviewer(): string {
  try {
    return localStorage.getItem(REVIEWER_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveReviewer(name: string): void {
  try {
    localStorage.setItem(REVIEWER_KEY, name);
  } catch {
    // storage unavailable (private mode etc.): the name just isn't remembered
  }
}

/** GET /jobs/:id/review's error for legacy-spec jobs (only templates have a review document). */
const NOT_A_TEMPLATE = 'job did not run a recipe';

export function ReviewPage({
  api,
  jobId,
  onDone,
  jobs = [],
  role = 'designer',
}: {
  api: Api;
  jobId: string;
  onDone: () => void;
  /** Operators review (edit, approve, reject) but neither re-run steps nor save references. */
  role?: Role;
  /** The polled job list: the review queue position and Next document come from it. */
  jobs?: readonly JobSummary[];
}) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState('fields');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [reviewer, setReviewer] = useState(loadReviewer);
  const [busy, setBusy] = useState(false);
  const [referenceName, setReferenceName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [stepRuns, setStepRuns] = useState<StepRun[]>([]);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [cursor, setCursor] = useState(-1);
  /** The flagged table cell explained under the table (Next flagged, or focusing one). */
  const [flagCell, setFlagCell] = useState<FlagTarget | null>(null);
  const [find, setFind] = useState('');
  const [layout, setLayoutState] = useState<ReviewLayout>(loadLayout);
  const setLayout = (patch: Partial<ReviewLayout>) =>
    setLayoutState((current) => {
      const next = { ...current, ...patch };
      saveLayout(next);
      return next;
    });
  const workspace = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  /** The model choices a re-run may use (ADR 0010). */
  const models = useModelChoices(api);
  const stepModel = (ref: string | null) => (ref ? modelDisplayName(ref, models) : '?');
  /** The plugins the workers run: whether a plugin step's re-run may take a model. */
  const plugins = usePlugins(api, role !== 'operator');
  /** The step whose model log (this job's attempts) is open. */
  const [logStep, setLogStep] = useState<string | null>(null);
  const [rerun, setRerun] = useState<{
    step: string;
    /** A plugin step: no page images, and a model only for a plugin that asks one. */
    plugin: boolean;
    instructions: string;
    pages: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.getReview(jobId));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab !== 'steps') return;
    api.getStepRuns(jobId).then(setStepRuns, () => setStepRuns([]));
  }, [api, jobId, tab]);

  const view = useMemo(() => (data ? effectiveView(data) : null), [data]);
  const targets = useMemo(
    () => (data && view ? flaggedTargets(view, data.template) : []),
    [data, view],
  );

  // Next flagged: a fresh view (after an edit) restarts the cycle from the top.
  useEffect(() => setCursor(-1), [targets]);
  useEffect(() => {
    if (!pendingFocus) return;
    window.document.getElementById(`flag-${pendingFocus}`)?.focus();
    setPendingFocus(null);
  }, [pendingFocus, tab]);

  if (error === NOT_A_TEMPLATE) {
    return (
      <p>
        This document type has no review view (legacy spec). See its outputs on the{' '}
        <a href={`#/results/${jobId}`}>Results page</a>.
      </p>
    );
  }
  if (error) return <p role="alert">Could not load review: {error}</p>;
  if (!data || !view) return <p>Loading review…</p>;

  const { job, template, document, edits } = data;
  const editable = job.status === 'awaiting_review';
  const pageCount = Math.max(1, Number(document.page_count ?? 1));
  const withEditor = <T extends object>(body: T) =>
    reviewer.trim() ? { ...body, editor: reviewer.trim() } : body;

  const extractSteps = template.pipeline.filter(
    (p) => p.type === 'extract' || p.type === 'plugin',
  ).length;
  const rerunStep = rerun ? template.pipeline.find((p) => p.id === rerun.step) : undefined;
  const asksModel =
    rerunStep?.type !== 'plugin' ||
    plugins.find((p) => p.ref === rerunStep.uses)?.egress === 'model';
  const hasGraph = job.outputs.some((o) => o.stage === 'draft' && o.format === 'rdf');
  const shaclReasons = (job.reviewReasons ?? []).filter((r) => r.startsWith('SHACL:')).length;
  /** A SHACL result's output: a field, a table or `table.column`; path IRIs open nothing. */
  const openOutput = (output: string) => {
    const table = template.outputs.tables.find(
      (t) => output === t.id || output.startsWith(`${t.id}.`),
    );
    if (table) setTab(table.id);
    else if (template.outputs.fields.some((f) => f.id === output)) {
      setTab('fields');
      setSelectedField(output);
    }
  };
  const nextFlagged = () => {
    const next = (cursor + 1) % targets.length;
    const target = targets[next]!;
    setCursor(next);
    setTab(target.tab);
    setFlagCell('field' in target ? null : target);
    if ('field' in target) {
      setSelectedField(target.field);
      const found = view.fields[target.field]?.page;
      if (found) setPage(found); // like clicking the field: show where it was found
    }
    setPendingFocus(targetKey(target));
  };
  // A render helper, not a component: a component declared here would remount every tab
  // (losing keyboard focus) on each render.
  const tabButton = (id: string, label: string, count: number, flagged = 0, twoLines = false) => {
    if (find.trim() && !label.toLowerCase().includes(find.trim().toLowerCase())) return null;
    const { title, ref } = twoLines ? splitName(label) : { title: label, ref: null };
    return (
      <button
        key={id}
        role="tab"
        type="button"
        aria-selected={tab === id}
        aria-label={`${label} ${count}${flagged ? ` (${flagged} flagged)` : ''}`}
        title={label}
        onClick={() => setTab(id)}
      >
        <span className="outline-name">
          <span>{title}</span>
          {ref && <small>{ref}</small>}
        </span>
        <span className="outline-counts">
          {flagged > 0 && (
            <span className="flag-chip" aria-hidden="true">
              <Icon name="flag" />
              {flagged}
            </span>
          )}
          <span className="tab-count">{count}</span>
        </span>
      </button>
    );
  };
  const flaggedCells = (id: string) =>
    (view.tables[id] ?? []).reduce(
      (n, r) => n + Object.values(r.cells).filter((c) => c.flags.length).length,
      0,
    );
  const flaggedFields = template.outputs.fields.filter(
    (f) => view.fields[f.id]?.flags.length,
  ).length;
  const flaggedTables = template.outputs.tables.filter((t) => flaggedCells(t.id) > 0).length;
  /** Pages a flagged field was found on (table cells carry no page). */
  const flaggedPages = new Set(
    template.outputs.fields
      .map((f) => view.fields[f.id])
      .filter((f) => f?.flags.length && f.page)
      .map((f) => f!.page!),
  );
  const tableIndex = template.outputs.tables.findIndex((t) => t.id === tab);
  const flagDetail =
    flagCell && flagCell.tab === tab && !('field' in flagCell)
      ? (() => {
          const t = template.outputs.tables.find((x) => x.id === flagCell.tab);
          const cell = view.tables[flagCell.tab]?.find((r) => r.number === flagCell.row)?.cells[
            flagCell.column
          ];
          const col = t?.columns.find((c) => c.id === flagCell.column);
          return cell?.flags.length && col ? { col: col.name ?? col.id, flags: cell.flags } : null;
        })()
      : null;
  const editFlagged = () => {
    if (!flagCell || 'field' in flagCell) return;
    window.document
      .getElementById(`flag-${targetKey(flagCell)}`)
      ?.querySelector<HTMLButtonElement>('button')
      ?.click();
  };

  // The divider: dragging or arrow keys move the document's share of the width.
  const widthAt = (clientX: number) => {
    const box = workspace.current?.getBoundingClientRect();
    if (!box || box.width === 0) return layout.docWidth;
    const pct = ((clientX - box.left) / box.width) * 100;
    return clampWidth(layout.docSide === 'left' ? pct : 100 - pct);
  };
  const onDividerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onDividerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) setLayout({ docWidth: widthAt(e.clientX) });
  };
  const onDividerUp = () => {
    dragging.current = false;
  };
  const onDividerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const towardsData = layout.docSide === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const towardsDoc = layout.docSide === 'left' ? 'ArrowLeft' : 'ArrowRight';
    const moves: Record<string, number> = {
      [towardsData]: layout.docWidth + DOC_WIDTH_STEP,
      [towardsDoc]: layout.docWidth - DOC_WIDTH_STEP,
      Home: MIN_DOC_WIDTH,
      End: MAX_DOC_WIDTH,
    };
    if (e.key in moves) {
      e.preventDefault();
      setLayout({ docWidth: clampWidth(moves[e.key]!) });
    }
  };

  const saveEdit = async (edit: EditRequest) => {
    await api.addEdit(jobId, withEditor(edit) as EditRequest);
    await load();
  };

  const decide = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const docPane =
    layout.hidden === 'doc' ? (
      <div className="pane-rail doc-rail">
        <button
          type="button"
          className="icon bordered"
          aria-label="Show the document"
          title="Show the document"
          onClick={() => setLayout({ hidden: null })}
        >
          <Icon name={layout.docSide === 'left' ? 'chevronRight' : 'chevronLeft'} />
        </button>
        <span className="rail-text">
          <strong>Document</strong> · page {page} of {pageCount}
        </span>
      </div>
    ) : (
      <PageViewer
        src={api.pageUrl(jobId, page)}
        thumbSrc={(n) => api.pageUrl(jobId, n)}
        page={page}
        pageCount={pageCount}
        flaggedPages={flaggedPages}
        onPage={setPage}
        actions={
          <>
            <button
              type="button"
              className="icon bordered"
              aria-label="Swap sides"
              title="Swap sides"
              onClick={() => setLayout({ docSide: layout.docSide === 'left' ? 'right' : 'left' })}
            >
              <Icon name="swap" />
            </button>
            <button
              type="button"
              className="icon bordered"
              aria-label="Hide the document"
              title="Hide the document"
              onClick={() => setLayout({ hidden: 'doc' })}
            >
              <Icon name={layout.docSide === 'left' ? 'chevronLeft' : 'chevronRight'} />
            </button>
          </>
        }
      />
    );
  const divider = layout.hidden === null && (
    <div
      className="review-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the document and the data"
      aria-valuenow={layout.docWidth}
      aria-valuemin={MIN_DOC_WIDTH}
      aria-valuemax={MAX_DOC_WIDTH}
      tabIndex={0}
      onPointerDown={onDividerDown}
      onPointerMove={onDividerMove}
      onPointerUp={onDividerUp}
      onPointerCancel={onDividerUp}
      onKeyDown={onDividerKey}
    >
      <span className="divider-grip" aria-hidden="true" />
    </div>
  );
  const dataPane =
    layout.hidden === 'data' ? (
      <div className="pane-rail data-rail">
        <button
          type="button"
          className="icon bordered"
          aria-label="Show the data"
          title="Show the data"
          onClick={() => setLayout({ hidden: null })}
        >
          <Icon name={layout.docSide === 'left' ? 'chevronLeft' : 'chevronRight'} />
        </button>
        <span className="rail-text">
          <strong>Extracted data</strong> · {targets.length} flagged
        </span>
      </div>
    ) : (
      <section className="review-data" aria-label="Extracted data">
        <div className="data-head">
          <span className="eyebrow">Extracted data</span>
          <span className="muted">
            {template.outputs.fields.length} fields · {template.outputs.tables.length} tables
            {targets.length > 0 && ` · ${targets.length} flagged`}
          </span>
          <span className="pane-actions">
            {layout.hidden === null && (
              <span role="group" aria-label="Document width" className="segmented">
                {DOC_WIDTH_PRESETS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    aria-label={`Document ${w}%`}
                    aria-pressed={layout.docWidth === w}
                    onClick={() => setLayout({ docWidth: w })}
                  >
                    {w} / {100 - w}
                  </button>
                ))}
              </span>
            )}
            <button
              type="button"
              className="icon bordered"
              aria-label="Hide the data"
              title="Hide the data"
              onClick={() => setLayout({ hidden: 'data' })}
            >
              <Icon name={layout.docSide === 'left' ? 'chevronRight' : 'chevronLeft'} />
            </button>
          </span>
        </div>
        <div className="data-body">
          <div className="data-outline">
            {targets.length > 0 && (
              <button type="button" className="next-flagged" onClick={nextFlagged}>
                <Icon name="flag" />
                Next flagged ({targets.length})
              </button>
            )}
            <span className="filter-search">
              <Icon name="search" />
              <input
                type="search"
                className="filter-field"
                aria-label="Find a table or field"
                placeholder="Find a table or field"
                value={find}
                onChange={(e) => setFind(e.target.value)}
              />
            </span>
            <div role="tablist" aria-label="Extracted data" aria-orientation="vertical">
              <p className="outline-head" aria-hidden="true">
                <span>Document</span>
              </p>
              {tabButton('fields', 'Fields', template.outputs.fields.length, flaggedFields)}
              {template.outputs.tables.length > 0 && (
                <p className="outline-head" aria-hidden="true">
                  <span>Tables</span>
                  {flaggedTables > 0 && <span>{flaggedTables} flagged</span>}
                </p>
              )}
              {template.outputs.tables.map((t) =>
                tabButton(
                  t.id,
                  t.name ?? t.id,
                  view.tables[t.id]?.length ?? 0,
                  flaggedCells(t.id),
                  true,
                ),
              )}
              <p className="outline-head" aria-hidden="true">
                <span>Review</span>
              </p>
              {tabButton('edits', 'Edits', edits.length)}
              {tabButton('steps', 'Steps', extractSteps)}
              {hasGraph && tabButton('graph', 'Graph', shaclReasons, shaclReasons)}
            </div>
          </div>
          <div className="data-view">
            {tab === 'graph' && hasGraph && (
              <GraphTab
                api={api}
                jobId={jobId}
                onOpenOutput={openOutput}
                {...(template.semantics ? { semantics: template.semantics } : {})}
              />
            )}

            {tab === 'fields' && (
              <FieldsGrid
                template={template}
                view={view}
                editable={editable}
                selected={selectedField}
                onSelect={setSelectedField}
                onPage={setPage}
                onSave={saveEdit}
              />
            )}

            {template.outputs.tables
              .filter((t) => t.id === tab)
              .map((t) => {
                const rows = (view.tables[t.id] ?? []).filter((r) => !flaggedOnly || r.flagged);
                return (
                  <div key={t.id} className="data-table-view">
                    <div className="data-view-head">
                      <h3>{t.name ?? t.id}</h3>
                      <span className="muted">{(view.tables[t.id] ?? []).length} rows</span>
                      {flaggedCells(t.id) > 0 && (
                        <span className="flag-chip">
                          <Icon name="flag" />
                          {flaggedCells(t.id)} flagged
                        </span>
                      )}
                      <span className="data-view-tools">
                        <span role="group" aria-label="Rows" className="segmented">
                          <button
                            type="button"
                            aria-pressed={!flaggedOnly}
                            onClick={() => setFlaggedOnly(false)}
                          >
                            All rows
                          </button>
                          <button
                            type="button"
                            aria-pressed={flaggedOnly}
                            onClick={() => setFlaggedOnly(true)}
                          >
                            Flagged only
                          </button>
                        </span>
                        {(() => {
                          const prev = template.outputs.tables[tableIndex - 1];
                          const next = template.outputs.tables[tableIndex + 1];
                          return (
                            <>
                              <button
                                type="button"
                                className="icon bordered"
                                aria-label={
                                  prev
                                    ? `Previous table: ${prev.name ?? prev.id}`
                                    : 'Previous table'
                                }
                                disabled={!prev}
                                onClick={() => prev && setTab(prev.id)}
                              >
                                <Icon name="chevronLeft" />
                              </button>
                              <button
                                type="button"
                                className="icon bordered"
                                aria-label={
                                  next ? `Next table: ${next.name ?? next.id}` : 'Next table'
                                }
                                disabled={!next}
                                onClick={() => next && setTab(next.id)}
                              >
                                <Icon name="chevronRight" />
                              </button>
                            </>
                          );
                        })()}
                      </span>
                    </div>
                    <div className="table-scroll">
                      <table aria-label={t.id}>
                        <thead>
                          <tr>
                            <th>#</th>
                            {t.columns.map((c) => (
                              <th key={c.id} title={c.description}>
                                {c.name ?? c.id}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.number}>
                              <td>{r.number}</td>
                              {t.columns.map((c) => {
                                const cell = r.cells[c.id]!;
                                const label = `${t.id} row ${r.number} ${c.id}`;
                                return (
                                  <td
                                    key={c.id}
                                    id={`flag-${t.id}:${r.number}:${c.id}`}
                                    tabIndex={-1}
                                    onFocus={() =>
                                      cell.flags.length
                                        ? setFlagCell({
                                            tab: t.id,
                                            row: r.number,
                                            column: c.id,
                                          })
                                        : undefined
                                    }
                                    className={
                                      [
                                        cell.flags.length ? 'flag' : '',
                                        cell.edit ? 'edited-cell' : '',
                                      ]
                                        .join(' ')
                                        .trim() || undefined
                                    }
                                    title={
                                      cell.flags.join('; ') ||
                                      (cell.edit ? `was ${display(cell.edit.oldValue)}` : undefined)
                                    }
                                  >
                                    <EditableValue
                                      def={c}
                                      value={cell.value}
                                      editable={editable}
                                      editLabel={`Edit ${label}`}
                                      inputLabel={`New value for ${label}`}
                                      onSave={(value) =>
                                        saveEdit({
                                          table: t.id,
                                          row: r.number,
                                          column: c.id,
                                          value,
                                        })
                                      }
                                    />
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {flagDetail && flagCell && !('field' in flagCell) && (
                      <section className="flag-note" aria-label="Flagged value">
                        <strong>
                          Row {flagCell.row} · {flagDetail.col}
                        </strong>
                        <span>{flagDetail.flags.join('; ')}</span>
                        {editable && (
                          <button type="button" className="small" onClick={editFlagged}>
                            Edit value
                          </button>
                        )}
                      </section>
                    )}
                  </div>
                );
              })}

            {tab === 'steps' && (
              <div className="steps">
                <table aria-label="steps">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Fills</th>
                      <th>Last run</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {template.pipeline.map((step) => {
                      if (step.type !== 'extract' && step.type !== 'plugin') return null;
                      const last = stepRuns.filter((r) => r.stepId === step.id).at(-1);
                      return (
                        <tr key={step.id}>
                          <td>
                            <code>{step.id}</code>
                          </td>
                          <td>{step.table ?? step.fields.join(', ')}</td>
                          <td>
                            {last && step.type === 'plugin' && !last.model
                              ? `${step.uses} · ${last.status}` +
                                (last.trigger === 'rerun' ? ' · re-run' : '')
                              : last?.cached
                                ? `${stepModel(last.model)} · cached · ${last.status}`
                                : last
                                  ? `${stepModel(last.model)} · ${last.attempts} attempt(s) · ${last.status}` +
                                    (last.outputTokens
                                      ? ` · ${last.outputTokens} output tokens`
                                      : '') +
                                    (last.trigger === 'rerun' ? ' · re-run' : '')
                                  : '—'}
                          </td>
                          <td>
                            {role !== 'operator' && last && last.model !== null && !last.cached && (
                              <button
                                type="button"
                                className="link"
                                aria-label={`Model log of ${step.id}`}
                                onClick={() => setLogStep(step.id)}
                              >
                                Model log
                              </button>
                            )}{' '}
                            {editable && role !== 'operator' && (
                              <button
                                type="button"
                                aria-label={`Re-run ${step.id}`}
                                onClick={() =>
                                  setRerun({
                                    step: step.id,
                                    plugin: step.type === 'plugin',
                                    instructions: '',
                                    pages: String(page),
                                  })
                                }
                              >
                                Re-run
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {logStep && (
                  <StepAttemptsDialog
                    api={api}
                    jobId={jobId}
                    stepId={logStep}
                    onClose={() => setLogStep(null)}
                  />
                )}
                {rerun && (
                  <ReprocessDialog
                    title={`Re-run ${rerun.step}`}
                    confirmLabel="Queue re-run"
                    choices={models}
                    emptyLabel="Step default"
                    noModel={!asksModel}
                    summary={
                      rerun.plugin ? (
                        <p>
                          Only <code>{rerun.step}</code> runs again (OCR is reused); its values are
                          replaced and the checks re-run. The plugin reads your guidance.
                        </p>
                      ) : (
                        <p>
                          Only <code>{rerun.step}</code> calls the model again (OCR is reused); its
                          values are replaced and the checks re-run.
                        </p>
                      )
                    }
                    onConfirm={async (model) => {
                      await api.rerunStep(jobId, rerun.step, {
                        ...(model ? { model } : {}),
                        ...(rerun.instructions.trim()
                          ? { instructions: rerun.instructions.trim() }
                          : {}),
                        ...(!rerun.plugin && pageList(rerun.pages).length
                          ? { pageImages: pageList(rerun.pages) }
                          : {}),
                      });
                      onDone();
                    }}
                    onClose={() => setRerun(null)}
                  >
                    <label>
                      Guidance for re-run
                      <textarea
                        rows={3}
                        value={rerun.instructions}
                        onChange={(e) => setRerun({ ...rerun, instructions: e.target.value })}
                      />
                    </label>
                    {!rerun.plugin && (
                      <label title="Sent as images so a vision model reads the pages directly (e.g. handwriting the OCR misread). Leave empty for text only.">
                        Pages to show the model
                        <input
                          value={rerun.pages}
                          onChange={(e) => setRerun({ ...rerun, pages: e.target.value })}
                        />
                      </label>
                    )}
                  </ReprocessDialog>
                )}
              </div>
            )}

            {tab === 'edits' && (
              <ol className="edit-log">
                {edits.length === 0 && <li>No edits yet.</li>}
                {edits.map((e) => (
                  <li key={e.id}>
                    <strong>{e.field ?? `${e.table} row ${e.row} ${e.column}`}</strong>:{' '}
                    {display(e.oldValue)} → {display(e.newValue)}
                    <small>
                      {' '}
                      {e.editor ?? 'unknown'} · {new Date(e.at).toLocaleString()}
                      {e.reason ? ` · ${e.reason}` : ''}
                    </small>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </section>
    );

  return (
    <div className="review">
      <ReviewHeader data={data} jobs={jobs} jobId={jobId} models={models} />

      <div
        ref={workspace}
        className={`review-workspace doc-${layout.docSide}${layout.hidden ? ` hidden-${layout.hidden}` : ''}`}
        style={{ '--doc-width': `${layout.docWidth}%` } as CSSProperties}
      >
        {layout.docSide === 'left' ? (
          <>
            {docPane}
            {divider}
            {dataPane}
          </>
        ) : (
          <>
            {dataPane}
            {divider}
            {docPane}
          </>
        )}
      </div>

      {editable ? (
        <DecisionBar
          busy={busy}
          reviewer={reviewer}
          onReviewer={(name) => {
            setReviewer(name);
            saveReviewer(name);
          }}
          onApprove={(note) =>
            void decide(() =>
              api.approve(jobId, {
                ...(reviewer.trim() ? { reviewer: reviewer.trim() } : {}),
                ...(note ? { note } : {}),
              }),
            )
          }
          onReject={(reason) =>
            void decide(() =>
              api.reject(jobId, {
                reason,
                ...(reviewer.trim() ? { reviewer: reviewer.trim() } : {}),
              }),
            )
          }
        />
      ) : job.status === 'succeeded' && role !== 'operator' ? (
        <form
          className="decision-bar"
          aria-label="Save as reference"
          onSubmit={(e) => {
            e.preventDefault();
            void (async () => {
              try {
                const ref = await api.createReference(job.specId, jobId, referenceName.trim());
                setNotice(`Saved reference ${ref.name} for ${template.name}.`);
                setReferenceName('');
              } catch (err) {
                setError((err as Error).message);
              }
            })();
          }}
        >
          <p>
            Finished. Save these (reviewed) values as a reference: recipe changes can then be
            regression-tested against this document.
          </p>
          <label>
            Reference name
            <input value={referenceName} onChange={(e) => setReferenceName(e.target.value)} />
          </label>
          <button type="submit" disabled={!referenceName.trim()}>
            Save as reference
          </button>
          {notice && <p role="status">{notice}</p>}
        </form>
      ) : (
        <p className="decision-bar">
          {job.status === 'rejected'
            ? `Rejected by ${job.reviewer ?? 'unknown'}: ${job.reviewNote ?? ''}`
            : `This document is ${job.status}; review is closed.`}
        </p>
      )}
    </div>
  );
}
