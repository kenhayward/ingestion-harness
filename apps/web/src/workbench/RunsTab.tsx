import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DataPolicy, OverviewItem, QueueSummary, SampleView, TestRun } from '@ih/shared';
import type { Api } from '../api/client.js';
import { useModelChoices } from '../ui/ModelPicker.js';
import { ReprocessDialog } from '../ui/ReprocessDialog.js';
import { RunBatchCard, RunHead, RunRows } from './RunBatchCard.js';
import { RunSamples } from './RunSamples.js';
import {
  batchSubtitle,
  batchTitle,
  isActiveRun,
  olderText,
  queueText,
  runBatches,
  runBlockedReason,
  runLabel,
  runSamples,
  splitBatches,
} from './runs.js';
import { TabHeader } from './TabHeader.js';

interface Loaded {
  runs: TestRun[];
  samples: SampleView[];
  queue: QueueSummary | null;
}

/**
 * Test runs (handoff §11, TR1–TR4): pick dev samples, run the draft on them as one batch, follow
 * each batch's runs (status, step progress, duration) and open them in Review or retry them.
 * Polls while a run is queued or running, or a dev sample is still preparing.
 */
export function RunsTab({
  api,
  projectId,
  dataPolicy,
  draft,
  item,
  pollMs,
  onChanged,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  draft: number | null;
  item: OverviewItem | null;
  pollMs: number;
  /** A run started or the last active one finished: the page reloads its overview. */
  onChanged: () => void;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** null: untouched, so every ready dev sample is selected (newly ready ones join). */
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [asking, setAsking] = useState(false);
  const [retrying, setRetrying] = useState<TestRun | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const choices = useModelChoices(api);
  const seq = useRef(0);
  const inFlight = useRef(false);
  const wasActive = useRef(false);

  const load = useCallback(async () => {
    const id = ++seq.current;
    inFlight.current = true;
    try {
      const [runs, samples, queue] = await Promise.all([
        api.listTestRuns(projectId),
        api.listSamples(projectId),
        api.getQueueSummary().catch(() => null), // the queue line is optional
      ]);
      if (id !== seq.current) return; // a newer load (or unmount) superseded this one
      setData({ runs, samples, queue });
      setNow(Date.now());
      setError(null);
    } catch (err) {
      if (id === seq.current) setError((err as Error).message);
    } finally {
      if (id === seq.current) inFlight.current = false;
    }
  }, [api, projectId]);

  useEffect(() => {
    void load();
    const counter = seq; // the counter object itself, not a rendered node
    return () => {
      counter.current++;
    };
  }, [load]);

  const runsActive = data?.runs.some(isActiveRun) ?? false;
  const preparing = data?.samples.some((s) => s.role === 'dev' && s.state === 'preparing') ?? false;
  useEffect(() => {
    if (!runsActive && !preparing) return;
    const timer = setInterval(() => {
      if (!inFlight.current) void load();
    }, pollMs);
    return () => clearInterval(timer);
  }, [runsActive, preparing, pollMs, load]);

  // The page learns when the last active run finishes (its rail shows the tab's status).
  useEffect(() => {
    if (wasActive.current && !runsActive) onChanged();
    wasActive.current = runsActive;
  }, [runsActive, onChanged]);

  const sampleChoices = useMemo(() => runSamples(data?.samples ?? []), [data]);
  const selectable = sampleChoices.filter((c) => c.selectable).map((c) => c.sample.id);
  const selected = new Set(
    picked === null ? selectable : selectable.filter((id) => picked.has(id)),
  );
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  // Before the first load there is no count to show: neither "0 dev samples" nor a reason to pick.
  const loading = data === null && draft !== null;
  const blocked = loading ? 'Loading samples…' : runBlockedReason(draft, selected.size);
  const label = loading ? 'Run on dev samples' : runLabel(selected.size);

  const { batches, others } = useMemo(() => runBatches(data?.runs ?? []), [data]);
  const { shown, hidden } = splitBatches(batches);
  const visible = showOlder ? batches : shown;

  return (
    <div className="runs-tab">
      <TabHeader
        title="Test runs"
        item={item}
        description={
          draft !== null
            ? `Runs draft v${draft} on prepared dev samples so you can look at the results in Review. Test runs aren't scored (Evaluate compares with references), holdout samples are never used, and runs queue behind production jobs.`
            : 'Every version is published; start the next version on the Template tab to test-run it.'
        }
        actions={
          <button
            type="button"
            className="primary"
            disabled={blocked !== null}
            title={blocked ?? undefined}
            onClick={() => setAsking(true)}
          >
            {label}
          </button>
        }
      />
      {error && <p role="alert">{error}</p>}
      {data && (
        <RunSamples
          choices={sampleChoices}
          selected={selected}
          onToggle={toggle}
          queue={queueText(data.queue)}
        />
      )}
      {visible.map((batch) => {
        const title = batchTitle(batch, now);
        return (
          <RunBatchCard
            key={batch.id}
            batch={batch}
            title={title}
            subtitle={batchSubtitle(batch, choices)}
            now={now}
            onRetry={setRetrying}
          />
        );
      })}
      {hidden.length > 0 && (
        <p className="muted runs-older">
          <span>{showOlder ? 'Older batches shown' : olderText(hidden)}</span> ·{' '}
          <button
            type="button"
            className="link"
            aria-expanded={showOlder}
            onClick={() => setShowOlder((v) => !v)}
          >
            {showOlder ? 'Hide' : 'Show'}
          </button>
        </p>
      )}
      {data && batches.length === 0 && others.length === 0 && (
        <p className="muted">No test runs yet.</p>
      )}
      {others.length > 0 && (
        <section className="card runs-others" aria-labelledby="runs-others-title">
          <h3 id="runs-others-title">Other runs</h3>
          <p className="muted">
            Reference runs, evaluation runs and runs from before batches.{' '}
            <button
              type="button"
              className="link"
              aria-expanded={showOthers}
              onClick={() => setShowOthers((v) => !v)}
            >
              {showOthers ? 'Hide other runs' : `Show other runs (${others.length})`}
            </button>
          </p>
          {showOthers && (
            <div className="table-scroll">
              <table className="runs-table" aria-label="Other runs">
                <RunHead />
                <tbody>
                  <RunRows runs={others} now={now} onRetry={setRetrying} />
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {asking && draft !== null && (
        <ReprocessDialog
          title={`Run v${draft} on ${selected.size} dev sample${selected.size === 1 ? '' : 's'}`}
          confirmLabel="Run"
          choices={choices}
          emptyLabel="Template's models"
          dataPolicy={dataPolicy}
          summary={
            <p>
              Test-runs the draft on the selected dev samples (never holdout) as one batch.
              Unchanged steps reuse their cached output; nothing is delivered.
            </p>
          }
          onConfirm={async (model) => {
            await api.runDevTests(projectId, { model, sampleIds: [...selected] });
            onChanged();
            await load();
          }}
          onClose={() => setAsking(false)}
        />
      )}
      {retrying && (
        <ReprocessDialog
          title={`Retry ${retrying.filename}`}
          confirmLabel="Retry"
          choices={choices}
          initialModel={retrying.modelOverride ?? ''}
          emptyLabel="Template's models"
          dataPolicy={dataPolicy}
          summary={<p>Runs the draft on {retrying.filename} again, in the same batch.</p>}
          onConfirm={async (model) => {
            await api.retryJob(retrying.id, model);
            onChanged();
            await load();
          }}
          onClose={() => setRetrying(null)}
        />
      )}
    </div>
  );
}
