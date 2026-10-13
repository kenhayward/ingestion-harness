import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  outputNeeds,
  rightFirstTime,
  type DataPolicy,
  type OverviewItem,
  type ReferenceRow,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { Meter } from '../ui/Meter.js';
import { TabHeader } from './TabHeader.js';
import { isActive, readyBanner, unverifiedCount, verified } from './references.js';
import { useDefinitions } from './useDefinitions.js';

const POLICY_NOTE: Record<DataPolicy, string> = {
  local: 'Runs on local models; holdout samples are never sent.',
  external:
    'Dev sample text may be sent to an external model provider; holdout samples are never sent.',
};

const DESCRIPTION =
  'The draft model proposes the values for each dev sample; you correct and approve them in Review and save them as the reference. Evaluate scores every run against these references. Optional: without references Evaluate has nothing to score.';

const percent = (n: number, of: number) => (of === 0 ? 0 : n / of);

function runReason(
  hasDraft: boolean,
  running: boolean,
  count: number,
  set: 'dev' | 'holdout',
): string | null {
  if (!hasDraft) return 'Start a draft version first';
  if (running) return 'Reference runs are still running';
  if (count === 0) return `Every ${set} sample has a verified reference`;
  return null;
}

/** Stage 5 (handoff section 7): the draft model proposes values; the user verifies them in Review. */
export function ReferencesTab({
  api,
  projectId,
  dataPolicy,
  draft,
  published,
  item = null,
  pollMs,
  onChanged,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  draft: number | null;
  published: number | null;
  item?: OverviewItem | null;
  pollMs: number;
  onChanged: () => void;
}) {
  const hasDraft = draft !== null;
  const version = draft ?? published;
  const { draftDef } = useDefinitions(api, projectId, version, null, version !== null);
  const [rows, setRows] = useState<ReferenceRow[] | null>(null);
  const [holdoutRows, setHoldoutRows] = useState<ReferenceRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [devRows, holdout] = await Promise.all([
        api.listReferenceRows(projectId),
        api.listReferenceRows(projectId, 'holdout'),
      ]);
      setRows(devRows);
      setHoldoutRows(holdout);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const running = [...(rows ?? []), ...(holdoutRows ?? [])].some(
    (r) => r.run !== null && isActive(r.run.status),
  );
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [running, pollMs, refresh]);

  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const propose = () =>
    act(async () => {
      const jobs = await api.proposeReferences(projectId);
      setMessage(`${jobs.length} run${jobs.length === 1 ? '' : 's'} queued`);
      onChanged();
      await refresh();
    });
  const proposeHoldout = () =>
    act(async () => {
      const jobs = await api.startHoldoutReferenceRuns(projectId);
      setMessage(`${jobs.length} holdout run${jobs.length === 1 ? '' : 's'} queued`);
      onChanged();
      await refresh();
    });
  const skip = () =>
    act(async () => {
      await api.skipStage(projectId, 'references');
      setMessage('Stage skipped');
      onChanged();
    });

  const dev = useMemo(() => rows ?? [], [rows]);
  const holdout = holdoutRows ?? [];
  const devCount = unverifiedCount(dev);
  const holdoutCount = unverifiedCount(holdout);
  const devReason = runReason(hasDraft, busy || running, devCount, 'dev');
  const holdoutReason = runReason(hasDraft, busy || running, holdoutCount, 'holdout');
  const banner = readyBanner(dev, holdout, version);
  const right = useMemo(() => rightFirstTime(dev, draftDef), [dev, draftDef]);
  const needs = useMemo(() => outputNeeds(dev, draftDef), [dev, draftDef]);

  return (
    <div className="references-tab">
      <TabHeader
        title="References"
        item={item}
        description={DESCRIPTION}
        note={POLICY_NOTE[dataPolicy]}
        actions={
          <>
            <button
              type="button"
              className="primary"
              disabled={devReason !== null}
              title={devReason ?? undefined}
              onClick={() => void propose()}
            >
              Run the draft model on {devCount} unverified
            </button>
            <button type="button" disabled={busy} onClick={() => void skip()}>
              Skip this stage
            </button>
          </>
        }
      />
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {banner.ready && (
        <section className="card refs-ready" aria-label="Ready to evaluate">
          <p>
            <strong>Ready to evaluate.</strong> {banner.text}
          </p>
          <a className="button primary" href={`#/workbench/${projectId}/evaluate`}>
            Go to Evaluate
          </a>
        </section>
      )}
      <div className="refs-cards">
        <RefCard
          title="Dev references"
          n={dev.filter(verified).length}
          of={dev.length}
          version={version}
          tone="ok"
          note="Proposed by the draft model, corrected by you"
        />
        <RefCard
          title="Holdout references"
          n={holdout.filter(verified).length}
          of={holdout.length}
          version={version}
          tone="skip"
          note="Extracted by the template’s own models — never seen by drafting"
          action={
            <button
              type="button"
              disabled={holdoutReason !== null}
              title={holdoutReason ?? undefined}
              onClick={() => void proposeHoldout()}
            >
              Run the template on {holdoutCount} unverified holdout
            </button>
          }
        />
        <section className="card refs-card">
          <h3>Right first time</h3>
          <p className="refs-figure">
            <strong>
              {right.right} / {right.total}
            </strong>
            <span className="muted">
              {Math.round(percent(right.right, right.total) * 100)}% of dev values
            </span>
          </p>
          <Meter
            label="Right first time"
            value={right.total ? right.right / right.total : null}
            tone="accent"
          />
          <p className="muted">
            {right.excluded.length
              ? `Excludes ${right.excluded.join(', ')}, which no step fills yet`
              : 'Every output has a step'}
          </p>
        </section>
      </div>
      <NeedsStrip projectId={projectId} needs={needs} samples={right.references} />
      {/* Samples list and detail panel: Task 8 */}
    </div>
  );
}

function RefCard({
  title,
  n,
  of,
  version,
  tone,
  note,
  action,
}: {
  title: string;
  n: number;
  of: number;
  version: number | null;
  tone: 'ok' | 'skip';
  note: string;
  action?: ReactNode;
}) {
  return (
    <section className={`card refs-card${tone === 'skip' ? ' refs-card-holdout' : ''}`}>
      <h3>{title}</h3>
      <p className="refs-figure">
        <strong>
          {n} / {of}
        </strong>
        <span className="muted">verified for v{version ?? '?'}</span>
      </p>
      <Meter label={`${title} verified`} value={of ? n / of : null} tone={tone} />
      <p className="muted">{note}</p>
      {action}
    </section>
  );
}

const NEED_TEXT = { ok: 'right first time', warn: 'corrected', info: 'entered by hand' } as const;

function NeedsStrip({
  projectId,
  needs,
  samples,
}: {
  projectId: string;
  needs: ReturnType<typeof outputNeeds>;
  samples: number;
}) {
  const noStep = needs.filter((n) => !n.hasStep);
  return (
    <section className="card refs-needs">
      <h3>Where the draft model needed you</h3>
      <p className="muted">
        Values you changed in Review, per output, across the {samples} dev samples
      </p>
      <ul className="refs-chips">
        {needs.map((n) => {
          const tone = n.corrected > 0 ? 'warn' : n.entered > 0 ? 'info' : 'ok';
          return (
            <li key={n.id} className={`refs-chip tone-${tone}`}>
              <code>{n.id}</code> <span className="refs-chip-count">{n.corrected + n.entered}</span>
              <span className="visually-hidden"> — {NEED_TEXT[tone]}</span>
            </li>
          );
        })}
      </ul>
      <p className="refs-legend muted">
        <span className="tone-ok">● Right first time</span>{' '}
        <span className="tone-warn">● Corrected</span>{' '}
        <span className="tone-info">● Entered by hand (model left it empty)</span>
      </p>
      {noStep.length > 0 && (
        <p>
          {noStep.map((n) => n.id).join(', ')} {noStep.length === 1 ? 'has' : 'have'} no step yet —
          add one on <a href={`#/workbench/${projectId}/steps`}>the Steps tab</a>.
        </p>
      )}
    </section>
  );
}
