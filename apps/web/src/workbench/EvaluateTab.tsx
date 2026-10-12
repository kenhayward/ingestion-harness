import { useCallback, useEffect, useState } from 'react';
import {
  EVALUATION_MODELS,
  comparisonRows,
  type ComparisonView,
  type DataPolicy,
  type EvaluationModel,
  type IterationSummary,
  type IterationView,
} from '@ih/shared';
import type { Api } from '../api/client.js';

const POLICY_NOTE: Record<DataPolicy, string> = {
  local: 'Runs on local models; holdout samples are never sent.',
  external:
    'Dev sample text may be sent to an external model provider; holdout samples are never sent.',
};

const DASH = '—';
const DOT = '·';
const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);
const show = (v: unknown) =>
  v === null || v === undefined ? DASH : typeof v === 'string' ? v : JSON.stringify(v);

/** Evaluate the draft on verified dev samples; scorecard, drill-down and history (ADR 0007). */
export function EvaluateTab({
  api,
  projectId,
  dataPolicy,
  hasDraft,
  pollMs,
  onRestored,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  hasDraft: boolean;
  pollMs: number;
  onRestored: () => void;
}) {
  const [history, setHistory] = useState<IterationSummary[] | null>(null);
  const [current, setCurrent] = useState<IterationView | null>(null);
  const [model, setModel] = useState<EvaluationModel | ''>('');
  const [open, setOpen] = useState<string | null>(null);
  const [uncached, setUncached] = useState(false);
  const [comparison, setComparison] = useState<ComparisonView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.listIterations(projectId);
      setHistory(list);
      setCurrent(list[0] ? await api.getIteration(projectId, list[0].id) : null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const currentId = current?.id;
  const running = current?.status === 'running';
  useEffect(() => {
    if (!running || !currentId) return;
    let stopped = false;
    const timer = setInterval(() => {
      api.getIteration(projectId, currentId).then(
        (next) => {
          if (stopped) return;
          setCurrent(next);
          if (next.status !== 'running') {
            api.listIterations(projectId).then(
              (list) => {
                if (!stopped) setHistory(list);
              },
              (err: Error) => {
                if (!stopped) setError(`could not refresh the history: ${err.message}`);
              },
            );
          }
        },
        (err: Error) => {
          if (!stopped) setError(err.message);
        },
      );
    }, pollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [running, currentId, pollMs, api, projectId, load]);

  const comparisonId = comparison?.groupId;
  const comparing = comparison?.iterations.some((i) => i.status === 'running') ?? false;
  useEffect(() => {
    if (!comparing || !comparisonId) return;
    let stopped = false;
    const timer = setInterval(() => {
      api.getComparison(projectId, comparisonId).then(
        (next) => {
          if (stopped) return;
          setComparison(next);
          setError(null);
          if (!next.iterations.some((i) => i.status === 'running')) {
            api.listIterations(projectId).then(
              (list) => {
                if (!stopped) setHistory(list);
              },
              (err: Error) => {
                if (!stopped) setError(`could not refresh the history: ${err.message}`);
              },
            );
          }
        },
        (err: Error) => {
          if (!stopped) setError(err.message);
        },
      );
    }, pollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [comparing, comparisonId, pollMs, api, projectId]);

  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const evaluate = () =>
    act(async () => {
      const started = await api.startEvaluation(projectId, model || null, { uncached });
      setCurrent(started);
      setOpen(null);
      setHistory((h) => [started, ...(h ?? [])]);
    });
  const compare = () =>
    act(async () => {
      setComparison(await api.startComparison(projectId, { uncached }));
    });
  const restore = (id: string) =>
    act(async () => {
      if (!window.confirm('Replace the open draft with the template from this iteration?')) return;
      await api.restoreIteration(projectId, id);
      onRestored();
    });

  const accuracy = current ? [...current.scorecard.fields, ...current.scorecard.columns] : [];
  const opened = current?.samples.find((s) => s.jobId === open) ?? null;

  return (
    <div className="evaluate-tab">
      <p className="muted">{POLICY_NOTE[dataPolicy]}</p>
      <div className="actions">
        <label>
          Model{' '}
          <select value={model} onChange={(e) => setModel(e.target.value as EvaluationModel | '')}>
            <option value="">Template&apos;s models</option>
            {EVALUATION_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={uncached}
            onChange={(e) => setUncached(e.target.checked)}
          />{' '}
          Fresh model calls (skip the step cache)
        </label>
        <button
          type="button"
          className="primary"
          disabled={!hasDraft || busy || running || comparing}
          onClick={() => void evaluate()}
        >
          Evaluate the draft
        </button>
        <button
          type="button"
          disabled={!hasDraft || busy || running || comparing}
          onClick={() => void compare()}
        >
          Compare models
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {comparison && (
        <table aria-label="Model comparison">
          <thead>
            <tr>
              <th>Measure</th>
              {comparison.iterations.map((i) => (
                <th key={i.id}>
                  {i.model ?? 'template'}
                  {i.status === 'running' && ' (running)'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {comparisonRows(comparison.iterations).map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                {comparison.iterations.map((i) => (
                  <td key={i.id}>{pct(row.byModel[i.model ?? 'template'] ?? null)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {current && (
        <section aria-label="Latest evaluation">
          <h3>Score {pct(current.score)}</h3>
          <p className="muted">
            v{current.templateVersion} {DOT} {current.model ?? "template's models"} {DOT}{' '}
            {current.completed} of {current.total} compared {DOT} {current.status}
          </p>
          {current.cache.total > 0 && (
            <p className="muted">
              Reused {current.cache.reused} of {current.cache.total} steps from the cache
            </p>
          )}
          <table aria-label="Samples">
            <thead>
              <tr>
                <th>Sample</th>
                <th>Score</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {current.samples.map((s, i) => (
                <tr key={`${i}-${s.jobId ?? s.filename}`}>
                  <td>{s.filename}</td>
                  <td>{s.comparison ? pct(s.comparison.score) : '–'}</td>
                  <td>
                    {s.status ? s.status.replace('_', ' ') : 'deleted'}
                    {s.error && <small className="muted"> {s.error}</small>}
                  </td>
                  <td>
                    {s.jobId && <a href={`#/review/${s.jobId}`}>Review</a>}{' '}
                    {s.comparison && s.jobId && (
                      <button
                        type="button"
                        onClick={() => setOpen(open === s.jobId ? null : s.jobId)}
                      >
                        Details
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {opened?.comparison && (
            <table aria-label={`Fields in ${opened.filename}`}>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Expected</th>
                  <th>Actual</th>
                  <th>Match</th>
                </tr>
              </thead>
              <tbody>
                {opened.comparison.fields.map((f) => (
                  <tr key={f.id}>
                    <td>{f.id}</td>
                    <td>{show(f.expected)}</td>
                    <td>{show(f.actual)}</td>
                    <td>{f.match ? '✓' : '✗'}</td>
                  </tr>
                ))}
                {opened.comparison.tables.map((t) => (
                  <tr key={`table-${t.id}`}>
                    <td>{t.id}</td>
                    <td>{t.expected} rows</td>
                    <td>{t.actual} rows</td>
                    <td>
                      {t.matched} matched {DOT} {t.changed.length} changed {DOT} {t.missing.length}{' '}
                      missing {DOT} {t.extra.length} extra
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <table aria-label="Field accuracy">
            <thead>
              <tr>
                <th>Field or column</th>
                <th>Correct</th>
                <th>Accuracy</th>
              </tr>
            </thead>
            <tbody>
              {accuracy.map((a) => (
                <tr key={a.id}>
                  <td>{a.id}</td>
                  <td>
                    {a.matched} / {a.total}
                  </td>
                  <td>{pct(a.accuracy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {history && history.length > 0 && (
        <table aria-label="History">
          <thead>
            <tr>
              <th>Version</th>
              <th>Model</th>
              <th>Score</th>
              <th>When</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td>v{h.templateVersion}</td>
                <td>
                  {h.model ?? "template's"}
                  {h.uncached && ` ${DOT} fresh`}
                  {h.groupId && ` ${DOT} compare`}
                </td>
                <td>{h.status === 'complete' ? pct(h.score) : 'running'}</td>
                <td>{new Date(h.createdAt).toLocaleString()}</td>
                <td>
                  <button type="button" disabled={busy} onClick={() => void restore(h.id)}>
                    Restore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
