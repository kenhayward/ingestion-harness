import { useCallback, useEffect, useRef, useState } from 'react';
import {
  comparisonRows,
  type ComparisonView,
  type DataPolicy,
  type EvaluationSet,
  type IterationSummary,
  type IterationView,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { useModelChoices } from '../ui/ModelPicker.js';
import { ReprocessDialog } from '../ui/ReprocessDialog.js';
import { Segmented, type SegmentedOption } from '../ui/Segmented.js';
import { AccuracyCard, HistoryCard } from './EvaluateHistory.js';
import { LatestRun } from './EvaluateLatest.js';
import { GateCard, useGate } from './GateCard.js';
import { devScore, latestOf } from './evaluate.js';
import { verified } from './references.js';

const POLICY_NOTE: Record<DataPolicy, string> = {
  local: 'Runs on local models; holdout samples are never sent.',
  external:
    'Dev sample text may be sent to an external model provider; holdout samples are never sent.',
};

export const HOLDOUT_MODEL_REASON =
  "Holdout runs use the recipe's own models: only they are measured against the threshold";
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
  onGateChanged,
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
  /** Called after the threshold was saved: the page's gate-dependent status is stale. */
  onGateChanged?: () => void;
}) {
  const [set, setSet] = useState<EvaluationSet>('dev');
  const choices = useModelChoices(api);
  /** The re-process dialog open for an evaluation or a comparison. */
  const [asking, setAsking] = useState<'evaluate' | 'compare' | null>(null);
  /** The choices ticked for a comparison; null: every one this project may use. */
  const [ticked, setTicked] = useState<string[] | null>(null);
  const usable = choices.filter((c) => dataPolicy === 'external' || c.location === 'local');
  const compared = ticked ?? usable.map((c) => c.id);
  /** An iteration's model by its choice's label; older names (fast, draft) as they are. */
  const nameOf = (m: string | null) =>
    m === null ? "recipe's models" : (choices.find((c) => c.id === m)?.label ?? m);
  const [uncached, setUncached] = useState(false);
  const [history, setHistory] = useState<IterationSummary[] | null>(null);
  const [current, setCurrent] = useState<IterationView | null>(null);
  const [comparison, setComparison] = useState<ComparisonView | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const error = actionError ?? pollError;
  /** Verified references per set (null: not known yet; an unknown count never blocks). */
  const [verifiedCount, setVerifiedCount] = useState<Partial<Record<EvaluationSet, number>>>({});
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
      setPollError(null);
    } catch (err) {
      if (n === seq.current) setPollError((err as Error).message);
    }
  }, [api, projectId, set]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let stale = false;
    api.listReferenceRows(projectId, set).then(
      (rows) => {
        if (!stale) setVerifiedCount((c) => ({ ...c, [set]: rows.filter(verified).length }));
      },
      () => {
        // The API decides when a start is refused; an unreadable list never blocks.
      },
    );
    return () => {
      stale = true;
    };
  }, [api, projectId, set]);

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
          setPollError(null);
          if (!next.iterations.some((i) => i.status === 'running')) void load();
        },
        (err: Error) => {
          if (!stopped) setPollError(err.message);
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
  const reloadGate = gate.reload;
  const threshold = gate.gate?.threshold ?? gate.threshold?.value ?? DEFAULT_THRESHOLD;

  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const holdout = set === 'holdout';
  const shown = current?.set === set ? current : null;
  const running = shown?.status === 'running';
  const noReferences =
    verifiedCount[set] === 0
      ? `No verified ${set} references yet — save some on the References tab`
      : null;
  const evaluateBlocked =
    draft === null
      ? 'Start a draft version first'
      : noReferences
        ? noReferences
        : running
          ? 'An evaluation of this set is still running'
          : comparing
            ? 'A model comparison is still running'
            : busy
              ? 'Starting…'
              : null;
  const compareBlocked = draft !== null && holdout ? COMPARE_HOLDOUT_REASON : evaluateBlocked;

  /** Run from the re-process dialog: a refusal stays there, with its reason. */
  const evaluate = async (model: string | null) => {
    const started = await api.startEvaluation(projectId, holdout ? null : model, {
      uncached,
      set,
    });
    setCurrent(started);
    setHistory((h) => [started, ...(h ?? [])]);
    onStarted?.();
  };
  const compare = async () => {
    setComparison(await api.startComparison(projectId, { uncached, models: compared }));
    onStarted?.();
  };
  const restore = (id: string) =>
    void act(async () => {
      if (!window.confirm('Replace the open draft with the recipe from this iteration?')) return;
      await api.restoreIteration(projectId, id);
      onRestored();
      void reloadGate();
      void load();
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
        onChanged={() => {
          void reloadGate();
          onGateChanged?.();
        }}
        onPublished={onRestored}
      />
      {gate.error && <p role="alert">{gate.error}</p>}
      <section className="card eval-runbar" aria-label="Run">
        <h3>Run</h3>
        <Segmented label="Sample set" options={SETS} value={set} onChange={setSet} />
        <label title="Skip the step cache: every step calls its model">
          <input
            type="checkbox"
            checked={uncached}
            onChange={(e) => setUncached(e.target.checked)}
          />{' '}
          Fresh model calls
        </label>
        <span className="muted eval-runbar-note">
          {holdout ? "Holdout: recipe's models only" : 'Dev: any model choice, or compare'}
        </span>
        <div className="eval-runbar-actions">
          <button
            type="button"
            disabled={compareBlocked !== null}
            title={compareBlocked ?? undefined}
            onClick={() => setAsking('compare')}
          >
            Compare models…
          </button>
          <button
            type="button"
            className="primary"
            disabled={evaluateBlocked !== null}
            title={evaluateBlocked ?? undefined}
            onClick={() => setAsking('evaluate')}
          >
            {draft === null ? `Evaluate on ${set}` : `Evaluate v${draft} on ${set}`}…
          </button>
        </div>
      </section>
      {asking === 'evaluate' && draft !== null && (
        <ReprocessDialog
          title={`Evaluate v${draft} on ${set}`}
          confirmLabel="Evaluate"
          choices={choices}
          emptyLabel="Document type's model"
          dataPolicy={dataPolicy}
          {...(holdout ? { fixedModel: "The recipe's own models" } : {})}
          summary={
            <p>
              Runs v{draft} on every verified {set} reference and scores it
              {uncached ? ', every step calling its model (fresh)' : ''}.
              {holdout ? ` ${HOLDOUT_MODEL_REASON}.` : ''}
            </p>
          }
          onConfirm={evaluate}
          onClose={() => setAsking(null)}
        />
      )}
      {asking === 'compare' && draft !== null && (
        <ReprocessDialog
          title={`Compare models on v${draft}`}
          confirmLabel="Compare"
          choices={choices}
          noModel
          canConfirm={compared.length >= 2}
          summary={
            <p>
              Evaluates v{draft} on the dev samples once per model choice ticked (at least two),
              side by side{uncached ? ', every step calling its model (fresh)' : ''}.
            </p>
          }
          onConfirm={compare}
          onClose={() => setAsking(null)}
        >
          <fieldset className="compare-choices" aria-label="Models to compare">
            <legend className="muted">Compare (at least two)</legend>
            {choices.map((c) => {
              const allowed = usable.includes(c);
              return (
                <label key={c.id} title={c.ref}>
                  <input
                    type="checkbox"
                    disabled={!allowed}
                    checked={allowed && compared.includes(c.id)}
                    onChange={(e) =>
                      setTicked(
                        e.target.checked
                          ? usable
                              .map((u) => u.id)
                              .filter((id) => id === c.id || compared.includes(id))
                          : compared.filter((id) => id !== c.id),
                      )
                    }
                  />{' '}
                  {c.label}
                  {c.location === 'external' ? ' · external' : ''}
                </label>
              );
            })}
          </fieldset>
        </ReprocessDialog>
      )}
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
                      {nameOf(i.model)}
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
            iteration={shown}
            set={set}
            threshold={threshold}
          />
        </div>
        <div className="eval-side" tabIndex={0} aria-label="Accuracy and history">
          {shown && <AccuracyCard iteration={shown} threshold={threshold} />}
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
