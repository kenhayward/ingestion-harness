import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EVALUATION_MODELS,
  comparisonRows,
  type ComparisonView,
  type DataPolicy,
  type EvaluationModel,
  type EvaluationSet,
  type IterationSummary,
  type IterationView,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { Segmented, type SegmentedOption } from '../ui/Segmented.js';
import { AccuracyCard, HistoryCard } from './EvaluateHistory.js';
import { LatestRun } from './EvaluateLatest.js';
import { GateCard, useGate } from './GateCard.js';
import { devScore, latestOf } from './evaluate.js';

const POLICY_NOTE: Record<DataPolicy, string> = {
  local: 'Runs on local models; holdout samples are never sent.',
  external:
    'Dev sample text may be sent to an external model provider; holdout samples are never sent.',
};

export const HOLDOUT_MODEL_REASON =
  "Holdout runs use the template's own models: only they are measured against the threshold";
export const COMPARE_HOLDOUT_REASON =
  'Model comparison runs on dev samples only; holdout samples are never compared across models';

const SETS: readonly SegmentedOption<EvaluationSet>[] = [
  { value: 'holdout', label: 'Holdout' },
  { value: 'dev', label: 'Dev' },
];
const DEFAULT_THRESHOLD = 0.9;
const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);

/**
 * Evaluate and publish (handoff §8 after #77): the informational gate card, the run bar, the
 * latest run of the selected set, accuracy by output and the history. Polls only while a run or
 * a model comparison is active.
 */
export function EvaluateTab({
  api,
  projectId,
  dataPolicy,
  draft,
  published,
  pollMs,
  onRestored,
  onStarted,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  /** The open draft version; null when every version is published. */
  draft: number | null;
  published: number | null;
  pollMs: number;
  onRestored: () => void;
  /** Called after an evaluation or a model comparison has been started. */
  onStarted?: () => void;
}) {
  const [set, setSet] = useState<EvaluationSet>('dev');
  const [model, setModel] = useState<EvaluationModel | ''>('');
  const [uncached, setUncached] = useState(false);
  const [history, setHistory] = useState<IterationSummary[] | null>(null);
  const [current, setCurrent] = useState<IterationView | null>(null);
  const [comparison, setComparison] = useState<ComparisonView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const list = await api.listIterations(projectId);
      const latest = latestOf(list, set);
      const view = latest ? await api.getIteration(projectId, latest.id) : null;
      if (n !== seq.current) return; // a set switch or a newer poll superseded this one
      setHistory(list);
      setCurrent(view);
      setError(null);
    } catch (err) {
      if (n === seq.current) setError((err as Error).message);
    }
  }, [api, projectId, set]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = history?.some((h) => h.status === 'running') ?? false;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [active, load, pollMs]);

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
          if (!next.iterations.some((i) => i.status === 'running')) void load();
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
  }, [comparing, comparisonId, pollMs, api, projectId, load]);

  const gateKey = (history ?? []).map((h) => `${h.id}:${h.status}`).join(',');
  const gate = useGate(api, projectId, draft, gateKey);
  const threshold = gate.gate?.threshold ?? gate.threshold?.value ?? DEFAULT_THRESHOLD;

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

  const holdout = set === 'holdout';
  const running = current?.status === 'running';
  const evaluateBlocked =
    draft === null
      ? 'Start a draft version first'
      : running
        ? 'An evaluation of this set is still running'
        : comparing
          ? 'A model comparison is still running'
          : busy
            ? 'Starting…'
            : null;
  const compareBlocked = draft !== null && holdout ? COMPARE_HOLDOUT_REASON : evaluateBlocked;

  const evaluate = () =>
    act(async () => {
      const started = await api.startEvaluation(projectId, holdout ? null : model || null, {
        uncached,
        set,
      });
      setCurrent(started);
      setHistory((h) => [started, ...(h ?? [])]);
      onStarted?.();
    });
  const compare = () =>
    act(async () => {
      setComparison(await api.startComparison(projectId, { uncached }));
      onStarted?.();
    });
  const restore = (id: string) =>
    void act(async () => {
      if (!window.confirm('Replace the open draft with the template from this iteration?')) return;
      await api.restoreIteration(projectId, id);
      onRestored();
    });

  return (
    <div className="eval-tab">
      <p className="muted">{POLICY_NOTE[dataPolicy]}</p>
      <GateCard
        api={api}
        projectId={projectId}
        draft={draft}
        published={published}
        gate={gate.gate}
        publications={gate.publications}
        threshold={gate.threshold}
        devScore={history ? devScore(history, draft) : null}
        onChanged={() => void gate.reload()}
        onPublished={onRestored}
      />
      {gate.error && <p role="alert">{gate.error}</p>}
      <section className="card eval-runbar" aria-label="Run">
        <h3>Run</h3>
        <Segmented label="Sample set" options={SETS} value={set} onChange={setSet} />
        <label>
          Model{' '}
          <select
            value={holdout ? '' : model}
            disabled={holdout}
            title={holdout ? HOLDOUT_MODEL_REASON : undefined}
            onChange={(e) => setModel(e.target.value as EvaluationModel | '')}
          >
            <option value="">Template&apos;s models</option>
            {EVALUATION_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label title="Skip the step cache: every step calls its model">
          <input
            type="checkbox"
            checked={uncached}
            onChange={(e) => setUncached(e.target.checked)}
          />{' '}
          Fresh model calls
        </label>
        <span className="muted eval-runbar-note">
          {holdout ? "Holdout: template's models only" : 'Dev: any model, or compare'}
        </span>
        <div className="eval-runbar-actions">
          <button
            type="button"
            disabled={compareBlocked !== null}
            title={compareBlocked ?? undefined}
            onClick={() => void compare()}
          >
            Compare models
          </button>
          <button
            type="button"
            className="primary"
            disabled={evaluateBlocked !== null}
            title={evaluateBlocked ?? undefined}
            onClick={() => void evaluate()}
          >
            {draft === null ? `Evaluate on ${set}` : `Evaluate v${draft} on ${set}`}
          </button>
        </div>
      </section>
      {error && <p role="alert">{error}</p>}
      {comparison && (
        <section className="card eval-compare" aria-label="Models compared">
          <h3>Model comparison</h3>
          <div className="table-scroll">
            <table aria-label="Model comparison">
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  {comparison.iterations.map((i) => (
                    <th scope="col" key={i.id}>
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
          </div>
        </section>
      )}
      <div className="eval-layout">
        <div className="eval-main">
          <LatestRun
            api={api}
            projectId={projectId}
            iteration={current}
            set={set}
            threshold={threshold}
          />
        </div>
        <div className="eval-side">
          {current && <AccuracyCard iteration={current} threshold={threshold} />}
          <HistoryCard
            history={history ?? []}
            version={draft ?? published}
            threshold={threshold}
            busy={busy}
            onRestore={restore}
            publications={gate.publications}
          />
        </div>
      </div>
    </div>
  );
}
