import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EditRequest, StepRun } from '@ih/shared';
import type { Api, ReviewData } from '../api/client.js';
import { EditableValue } from './EditableValue.js';
import { display, effectiveView } from './effective.js';
import { PageViewer } from './PageViewer.js';

const REVIEWER_KEY = 'ih.reviewer';

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

export function ReviewPage({
  api,
  jobId,
  onDone,
}: {
  api: Api;
  jobId: string;
  onDone: () => void;
}) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState('fields');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [reviewer, setReviewer] = useState(loadReviewer);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [stepRuns, setStepRuns] = useState<StepRun[]>([]);
  const [rerun, setRerun] = useState<{ step: string; model: string; instructions: string } | null>(
    null,
  );

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
    if (tab === 'steps') api.getStepRuns(jobId).then(setStepRuns, () => setStepRuns([]));
  }, [api, jobId, tab]);

  const view = useMemo(() => (data ? effectiveView(data) : null), [data]);

  if (error) return <p role="alert">Could not load review: {error}</p>;
  if (!data || !view) return <p>Loading review…</p>;

  const { job, template, document, edits } = data;
  const editable = job.status === 'awaiting_review';
  const pageCount = Math.max(1, Number(document.page_count ?? 1));
  const withEditor = <T extends object>(body: T) =>
    reviewer.trim() ? { ...body, editor: reviewer.trim() } : body;

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
      <header className="review-header">
        <a href="#/">← Jobs</a>
        <h2>Review: {job.filename}</h2>
        <p>
          {template.name} v{template.version} ·{' '}
          <span className={`status status-${job.status}`}>{job.status}</span>
          {view.flaggedCount > 0 && <> · {view.flaggedCount} value(s) flagged</>}
        </p>
        {job.reviewReasons && job.reviewReasons.length > 0 && (
          <ul className="reasons">
            {job.reviewReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </header>

      <div className="review-body">
        <PageViewer
          src={api.pageUrl(jobId, page)}
          page={page}
          pageCount={pageCount}
          onPage={setPage}
        />

        <section className="review-data">
          <div role="tablist" aria-label="Extracted data">
            <button role="tab" aria-selected={tab === 'fields'} onClick={() => setTab('fields')}>
              Fields ({template.outputs.fields.length})
            </button>
            {template.outputs.tables.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
              >
                {t.name ?? t.id} ({view.tables[t.id]?.length ?? 0})
              </button>
            ))}
            <button role="tab" aria-selected={tab === 'edits'} onClick={() => setTab('edits')}>
              Edits ({edits.length})
            </button>
            <button role="tab" aria-selected={tab === 'steps'} onClick={() => setTab('steps')}>
              Steps
            </button>
          </div>

          {tab === 'fields' && (
            <table aria-label="fields" className="fields">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Value</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {template.outputs.fields.map((def) => {
                  const f = view.fields[def.id]!;
                  return (
                    <tr key={def.id} className={f.flags.length ? 'flagged' : undefined}>
                      <th scope="row" title={def.description}>
                        {def.name ?? def.id}
                        <small> {def.type}</small>
                      </th>
                      <td title={f.flags.join('; ') || undefined}>
                        <EditableValue
                          def={def}
                          value={f.value}
                          editable={editable}
                          editLabel="Edit"
                          inputLabel={`New value for ${def.id}`}
                          onSave={(value) => saveEdit({ field: def.id, value })}
                        />
                        {f.edit && (
                          <small className="edited" title={`was ${display(f.edit.oldValue)}`}>
                            edited{f.edit.editor ? ` by ${f.edit.editor}` : ''}
                          </small>
                        )}
                      </td>
                      <td>
                        {f.evidence && <q>{f.evidence}</q>}{' '}
                        {f.page !== null && (
                          <button type="button" className="link" onClick={() => setPage(f.page!)}>
                            p. {f.page}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
                          {last
                            ? `${last.model ?? '?'} · ${last.attempts} attempt(s) · ${last.status}` +
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
                                setRerun({ step: step.id, model: '', instructions: '' })
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
                <form
                  className="rerun"
                  aria-label={`Re-run ${rerun.step}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void decide(() =>
                      api.rerunStep(jobId, rerun.step, {
                        ...(rerun.model.trim() ? { model: rerun.model.trim() } : {}),
                        ...(rerun.instructions.trim()
                          ? { instructions: rerun.instructions.trim() }
                          : {}),
                      }),
                    );
                  }}
                >
                  <p>
                    Re-run <code>{rerun.step}</code>: only this step calls the model again (OCR is
                    reused), its values are replaced and the checks re-run.
                  </p>
                  <label>
                    Model for re-run
                    <input
                      value={rerun.model}
                      placeholder="step default"
                      onChange={(e) => setRerun({ ...rerun, model: e.target.value })}
                    />
                  </label>
                  <label>
                    Guidance for re-run
                    <textarea
                      rows={3}
                      value={rerun.instructions}
                      onChange={(e) => setRerun({ ...rerun, instructions: e.target.value })}
                    />
                  </label>
                  <button type="submit" disabled={busy}>
                    Queue re-run
                  </button>
                  <button type="button" className="link" onClick={() => setRerun(null)}>
                    Cancel
                  </button>
                </form>
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
        <footer className="decision">
          <label>
            Reviewer
            <input
              value={reviewer}
              onChange={(e) => {
                setReviewer(e.target.value);
                saveReviewer(e.target.value);
              }}
            />
          </label>
          <label>
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              decide(() =>
                api.approve(jobId, {
                  ...(reviewer.trim() ? { reviewer: reviewer.trim() } : {}),
                  ...(note.trim() ? { note: note.trim() } : {}),
                }),
              )
            }
          >
            Approve and publish
          </button>
          <label>
            Rejection reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            type="button"
            className="danger"
            disabled={busy || !reason.trim()}
            onClick={() =>
              decide(() =>
                api.reject(jobId, {
                  reason: reason.trim(),
                  ...(reviewer.trim() ? { reviewer: reviewer.trim() } : {}),
                }),
              )
            }
          >
            Reject
          </button>
        </footer>
      ) : (
        <p className="decision">
          {job.status === 'rejected'
            ? `Rejected by ${job.reviewer ?? 'unknown'}: ${job.reviewNote ?? ''}`
            : `This document is ${job.status}; review is closed.`}
        </p>
      )}
    </div>
  );
}
