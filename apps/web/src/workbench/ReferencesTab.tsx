import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  outputNeeds,
  rightFirstTime,
  type DataPolicy,
  correctionOutput,
  type OverviewItem,
  type ReferenceDetail,
  type ReferenceRow,
  type SampleView,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { Meter } from '../ui/Meter.js';
import { TabHeader } from './TabHeader.js';
import {
  REFERENCE_FILTERS,
  correctionSummary,
  isActive,
  matchesFilter,
  readyBanner,
  reviewHref,
  rowLine,
  rowStatus,
  shortDateTime,
  tracker,
  trackerLabel,
  unverifiedCount,
  verified,
  type ReferenceFilter,
} from './references.js';
import { SampleTag } from './tags.js';
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
  const [filter, setFilter] = useState<ReferenceFilter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [samples, setSamples] = useState<SampleView[]>([]);

  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [devRows, holdout, sampleList] = await Promise.all([
        api.listReferenceRows(projectId),
        api.listReferenceRows(projectId, 'holdout'),
        api.listSamples(projectId).catch(() => [] as SampleView[]),
      ]);
      if (mine !== seq.current) return;
      setSamples(sampleList);
      setRows(devRows);
      setHoldoutRows(holdout);
      setError(null);
    } catch (err) {
      if (mine === seq.current) setError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const running = [...(rows ?? []), ...(holdoutRows ?? [])].some(
    (r) => r.run !== null && isActive(r.run.status),
  );
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) onChanged();
    wasRunning.current = running;
  }, [running, onChanged]);
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
  const banner = readyBanner(dev, holdout, version, hasDraft);
  const right = useMemo(() => rightFirstTime(dev, draftDef), [dev, draftDef]);
  const needs = useMemo(() => outputNeeds(dev, draftDef), [dev, draftDef]);
  const current = selected ?? [...dev, ...holdout].find((r) => r.reference)?.sampleId ?? null;

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
        />
        <section className="card refs-card">
          <h3>Right first time</h3>
          {right.total === 0 ? (
            <p className="refs-figure">
              <strong>No score yet</strong>
              <span className="muted">no verified dev values</span>
            </p>
          ) : (
            <p className="refs-figure">
              <strong>
                {right.right} / {right.total}
              </strong>
              <span className="muted">
                {Math.round(percent(right.right, right.total) * 100)}% of dev values
              </span>
            </p>
          )}
          <Meter
            label="Right first time"
            value={right.total ? right.right / right.total : null}
            tone="accent"
          />
          <p className="muted">
            {right.excluded.length
              ? `Excludes ${right.excluded.join(', ')}, which no step fills yet`
              : needs.length === 0
                ? 'No outputs in the draft yet'
                : 'Every output has a step'}
          </p>
        </section>
      </div>
      <NeedsStrip projectId={projectId} needs={needs} samples={right.references} />
      <div className="refs-layout">
        <section className="card refs-samples" aria-label="Samples">
          <div className="refs-samples-head">
            <h3>Samples</h3>
            <div className="refs-filter" role="group" aria-label="Filter samples">
              {REFERENCE_FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {FILTER_LABEL[f]} {[...dev, ...holdout].filter((r) => matchesFilter(r, f)).length}
                </button>
              ))}
            </div>
          </div>
          <SampleGroup
            role="dev"
            rows={dev}
            filter={filter}
            selected={current}
            onSelect={setSelected}
            note="run by the draft model"
          />
          <SampleGroup
            role="holdout"
            rows={holdout}
            filter={filter}
            selected={current}
            onSelect={setSelected}
            note="run by the live template, sealed from drafting"
            action={
              <button
                type="button"
                disabled={holdoutReason !== null}
                title={holdoutReason ?? undefined}
                onClick={() => void proposeHoldout()}
              >
                Run the template on {holdoutCount} unverified
              </button>
            }
          />
          <NotCounted projectId={projectId} samples={samples} />
        </section>
        {current ? (
          <ReferenceDetailPanel
            key={`${current}:${[...dev, ...holdout].find((r) => r.sampleId === current)?.reference?.id ?? ''}`}
            api={api}
            projectId={projectId}
            sampleId={current}
            version={version}
            published={published}
          />
        ) : (
          <aside className="card refs-detail refs-detail-empty" aria-label="Reference values">
            <p className="muted">Select a verified sample to see its values</p>
          </aside>
        )}
      </div>
      <p className="muted">
        References carry over to the next version. Only those whose outputs change type, enum values
        or columns need verifying again; renaming or describing an output does not. Holdout samples
        are extracted by the live template’s own models and are never sent to the draft model.
      </p>
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
}: {
  title: string;
  n: number;
  of: number;
  version: number | null;
  tone: 'ok' | 'skip';
  note: string;
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
        Values you changed in Review, per output, across {samples} verified dev{' '}
        {samples === 1 ? 'reference' : 'references'}
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

const FILTER_LABEL = { all: 'All', corrected: 'Corrected', needs: 'Needs you' } as const;

function SampleGroup({
  role,
  rows,
  filter,
  selected,
  onSelect,
  note,
  action,
}: {
  role: 'dev' | 'holdout';
  rows: ReferenceRow[];
  filter: ReferenceFilter;
  selected: string | null;
  onSelect: (id: string) => void;
  note: string;
  action?: ReactNode;
}) {
  const label = role === 'dev' ? 'Dev samples' : 'Holdout samples';
  const shown = rows.filter((r) => matchesFilter(r, filter));
  return (
    <div role="group" aria-label={label} className="refs-group" data-role={role}>
      <div className="refs-group-head">
        <SampleTag role={role} />
        <strong>{label}</strong>
        <span className="muted">
          {rows.filter(verified).length} of {rows.length} verified · {note}
        </span>
        {action}
      </div>
      {shown.length === 0 ? (
        <p className="muted">
          {rows.length ? 'No samples match this filter.' : 'No ready samples.'}
        </p>
      ) : (
        <ul className="refs-rows">
          {shown.map((r) => {
            const t = tracker(r);
            const href = reviewHref(r);
            return (
              <li key={r.sampleId} className="refs-row">
                <button
                  type="button"
                  className="refs-row-main"
                  aria-pressed={selected === r.sampleId}
                  disabled={!r.reference}
                  title={r.reference ? undefined : 'No reference to show yet'}
                  onClick={() => onSelect(r.sampleId)}
                >
                  <span className="refs-row-name">
                    <code>{r.filename}</code>
                    <small className="muted">{rowLine(r)}</small>
                  </span>
                  <span className="refs-tracker" role="img" aria-label={trackerLabel(t)}>
                    {[t.ran, t.reviewed, t.saved].map((done, i) => (
                      <span
                        key={i}
                        className={`refs-dot${done ? ' done' : ''}`}
                        aria-hidden="true"
                      />
                    ))}
                  </span>
                  <span className="refs-row-status">{rowStatus(r)}</span>
                  <span className="refs-row-corrections">{correctionSummary(r)}</span>
                </button>
                {href && <a href={href}>Review</a>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function NotCounted({ projectId, samples }: { projectId: string; samples: SampleView[] }) {
  const parts = samples.flatMap((s) =>
    s.state === 'preparing'
      ? [`${s.filename} is still preparing`]
      : s.state === 'failed'
        ? [`${s.filename} failed to prepare`]
        : [],
  );
  if (parts.length === 0) return null;
  return (
    <p className="refs-foot muted">
      Not counted: {parts.join(' · ')}. <a href={`#/workbench/${projectId}/samples`}>Samples</a>
    </p>
  );
}

const PROVENANCE_TAG = {
  model: { text: 'MODEL ✓', tone: 'ok' },
  corrected: { text: 'CORRECTED', tone: 'warn' },
  entered: { text: 'BY HAND', tone: 'info' },
} as const;

const display = (v: unknown) =>
  v === null || v === undefined || v === '' ? '—' : typeof v === 'string' ? v : JSON.stringify(v);

function runText(detail: ReferenceDetail, published: number | null) {
  const run = detail.run;
  if (!run) return 'The run that proposed these values is no longer there';
  const models = run.models.length ? ` (${run.models.join(', ')})` : '';
  const who =
    run.modelOverride === 'draft'
      ? `the draft model${models}`
      : run.modelOverride === null
        ? `the live template${published === null ? '' : ` v${published}`}${models}`
        : `${run.modelOverride}${models}`;
  const changed =
    detail.corrections === null
      ? null
      : new Set(detail.corrections.map((c) => correctionOutput(c.key))).size;
  return `Run by ${who} · ${run.jobId}${
    changed === null ? '' : ` · ${changed} of ${detail.values.length} values changed in Review`
  }`;
}

function ReferenceDetailPanel({
  api,
  projectId,
  sampleId,
  version,
  published,
}: {
  api: Api;
  projectId: string;
  sampleId: string;
  version: number | null;
  published: number | null;
}) {
  const [detail, setDetail] = useState<ReferenceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setDetail(null);
    api.getReferenceDetail(projectId, sampleId).then(
      (d) => live && (setDetail(d), setError(null)),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [api, projectId, sampleId]);
  if (error)
    return (
      <aside className="card refs-detail">
        <p role="alert">{error}</p>
      </aside>
    );
  if (!detail)
    return (
      <aside className="card refs-detail">
        <p>Loading…</p>
      </aside>
    );
  const r = detail.reference;
  const holdout = detail.role === 'holdout';
  return (
    <aside
      className="card refs-detail"
      aria-label={`Reference ${detail.filename}`}
      data-role={detail.role}
    >
      <header>
        <SampleTag role={detail.role} /> <code>{detail.filename}</code>
        <p className="muted">
          Reference “{r.name}”{r.version !== null ? ` · v${r.version}` : ''} · saved{' '}
          {shortDateTime(r.createdAt)}
          {r.verifiedBy ? ` by ${r.verifiedBy}` : ''}
        </p>
        <p className="muted">{runText(detail, published)}</p>
        {detail.corrections === null && (
          <p className="muted">
            Which values were changed in Review is not known: the run was re-run or removed after
            the save.
          </p>
        )}
      </header>
      <div className="table-scroll">
        <table aria-label="Reference values">
          <thead>
            <tr>
              <th scope="col">Output</th>
              <th scope="col">Value</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {detail.values.map((v) => (
              <tr key={v.id}>
                <td>
                  <code>{v.id}</code>
                </td>
                <td>
                  {v.provenance === 'corrected' && v.kind === 'field' && (
                    <del>{display(v.proposed)}</del>
                  )}{' '}
                  {v.kind === 'table'
                    ? `${Array.isArray(v.value) ? v.value.length : 0} rows`
                    : display(v.value)}
                </td>
                <td>
                  {v.provenance ? (
                    <span className={`kind-tag tone-${PROVENANCE_TAG[v.provenance].tone}`}>
                      {PROVENANCE_TAG[v.provenance].text}
                    </span>
                  ) : (
                    detail.corrections !== null && (
                      <span className="kind-tag tone-warn">
                        Not verified for this version — re-verify
                      </span>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.sourceJobId && (
        <a className="button" href={`#/review/${r.sourceJobId}`}>
          Open in Review
        </a>
      )}
      <p className="muted">To change a value, run the sample again and save a new reference.</p>
      <p className="muted">
        {holdout
          ? 'Holdout values are only scored, never shown to drafting.'
          : `Saving again replaces this reference for v${version ?? '?'}.`}
      </p>
    </aside>
  );
}
