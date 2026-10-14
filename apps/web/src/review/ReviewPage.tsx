import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EditRequest, JobSummary, StepRun } from '@ih/shared';
import { modelDisplayName } from '../jobs/derive.js';
import type { Api, ReviewData } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { DecisionBar } from './DecisionBar.js';
import { EditableValue } from './EditableValue.js';
import { FieldsGrid } from './FieldsGrid.js';
import { GraphTab } from './GraphTab.js';
import { display, effectiveView } from './effective.js';
import { PageViewer } from './PageViewer.js';
import { flaggedTargets, targetKey } from './queue.js';
import { ReviewHeader } from './ReviewHeader.js';
import { useModelChoices } from '../ui/ModelPicker.js';
import { ReprocessDialog } from '../ui/ReprocessDialog.js';

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
}: {
  api: Api;
  jobId: string;
  onDone: () => void;
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
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  /** The model choices a re-run may use (ADR 0010). */
  const models = useModelChoices(api);
  const stepModel = (ref: string | null) => (ref ? modelDisplayName(ref, models) : '?');
  const [rerun, setRerun] = useState<{
    step: string;
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

  const fieldsFlagged = template.outputs.fields.some((f) => view.fields[f.id]?.flags.length);
  const extractSteps = template.pipeline.filter((p) => p.type === 'extract').length;
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
    if ('field' in target) {
      setSelectedField(target.field);
      const found = view.fields[target.field]?.page;
      if (found) setPage(found); // like clicking the field: show where it was found
    }
    setPendingFocus(targetKey(target));
  };
  // A render helper, not a component: a component declared here would remount every tab
  // (losing keyboard focus) on each render.
  const tabButton = (id: string, label: string, count: number, flagged = false) => (
    <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
      {label} <span className={flagged ? 'tab-count tone-warn' : 'tab-count'}>{count}</span>
      {flagged && <span className="visually-hidden"> (flagged)</span>}
    </button>
  );

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

  return (
    <div className="review">
      <ReviewHeader data={data} jobs={jobs} jobId={jobId} models={models} />

      <div className="review-panes">
        <PageViewer
          src={api.pageUrl(jobId, page)}
          page={page}
          pageCount={pageCount}
          onPage={setPage}
        />

        <section className="review-data" aria-label="Extracted data">
          <div className="data-tabs">
            <div role="tablist" aria-label="Extracted data">
              {tabButton('fields', 'Fields', template.outputs.fields.length, fieldsFlagged)}
              {template.outputs.tables.map((t) =>
                tabButton(
                  t.id,
                  t.name ?? t.id,
                  view.tables[t.id]?.length ?? 0,
                  (view.tables[t.id] ?? []).some((r) => r.flagged),
                ),
              )}
              {tabButton('edits', 'Edits', edits.length)}
              {tabButton('steps', 'Steps', extractSteps)}
              {hasGraph && tabButton('graph', 'Graph', shaclReasons, shaclReasons > 0)}
            </div>
            {targets.length > 0 && (
              <button type="button" className="next-flagged" onClick={nextFlagged}>
                <Icon name="flag" />
                Next flagged ({targets.length})
              </button>
            )}
          </div>

          {tab === 'graph' && hasGraph && (
            <GraphTab api={api} jobId={jobId} onOpenOutput={openOutput} />
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
                <div key={t.id}>
                  <label className="filter">
                    <input
                      type="checkbox"
                      checked={flaggedOnly}
                      onChange={(e) => setFlaggedOnly(e.target.checked)}
                    />
                    Flagged rows only
                  </label>
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
                                      saveEdit({ table: t.id, row: r.number, column: c.id, value })
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
                    if (step.type !== 'extract') return null;
                    const last = stepRuns.filter((r) => r.stepId === step.id).at(-1);
                    return (
                      <tr key={step.id}>
                        <td>
                          <code>{step.id}</code>
                        </td>
                        <td>{step.table ?? step.fields.join(', ')}</td>
                        <td>
                          {last?.cached
                            ? `${stepModel(last.model)} · cached · ${last.status}`
                            : last
                              ? `${stepModel(last.model)} · ${last.attempts} attempt(s) · ${last.status}` +
                                (last.outputTokens ? ` · ${last.outputTokens} output tokens` : '') +
                                (last.trigger === 'rerun' ? ' · re-run' : '')
                              : '—'}
                        </td>
                        <td>
                          {editable && (
                            <button
                              type="button"
                              aria-label={`Re-run ${step.id}`}
                              onClick={() =>
                                setRerun({
                                  step: step.id,
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
              {rerun && (
                <ReprocessDialog
                  title={`Re-run ${rerun.step}`}
                  confirmLabel="Queue re-run"
                  choices={models}
                  emptyLabel="Step default"
                  summary={
                    <p>
                      Only <code>{rerun.step}</code> calls the model again (OCR is reused); its
                      values are replaced and the checks re-run.
                    </p>
                  }
                  onConfirm={async (model) => {
                    await api.rerunStep(jobId, rerun.step, {
                      ...(model ? { model } : {}),
                      ...(rerun.instructions.trim()
                        ? { instructions: rerun.instructions.trim() }
                        : {}),
                      ...(pageList(rerun.pages).length
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
                  <label title="Sent as images so a vision model reads the pages directly (e.g. handwriting the OCR misread). Leave empty for text only.">
                    Pages to show the model
                    <input
                      value={rerun.pages}
                      onChange={(e) => setRerun({ ...rerun, pages: e.target.value })}
                    />
                  </label>
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
        </section>
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
      ) : job.status === 'succeeded' ? (
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
