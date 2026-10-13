import { useCallback, useEffect, useId, useState } from 'react';
import type { Publication, PublishGateView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Meter } from '../ui/Meter.js';
import { gateTag, gateTitle, HINT_LINK, hintText, parseThreshold } from './evaluate.js';

const DOT = '·';
const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);
/** The meters' scale (handoff §8): 70–100 %. */
const SCALE_MIN = 0.7;

export interface ThresholdInfo {
  value: number;
  setBy: string | null;
  setAt: string | null;
}

/** The gate (with EV1 hints), the publication log and the threshold; reloads on `refreshKey`. */
export function useGate(api: Api, projectId: string, draft: number | null, refreshKey: string) {
  const [state, setState] = useState<{
    gate: PublishGateView | null;
    publications: Publication[];
    threshold: ThresholdInfo | null;
  }>({ gate: null, publications: [], threshold: null });
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const [gate, publications, view] = await Promise.all([
        draft === null ? null : api.getPublishGate(projectId),
        api.listPublications(projectId),
        api.getProject(projectId),
      ]);
      const { publishThreshold, thresholdSetBy, thresholdSetAt } = view.project;
      setState({
        gate,
        publications,
        threshold: { value: publishThreshold, setBy: thresholdSetBy, setAt: thresholdSetAt },
      });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId, draft]);
  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);
  return { ...state, error, reload };
}

function GateMeter({
  name,
  note,
  value,
  threshold,
  tone,
}: {
  name: string;
  note: string;
  value: number | null;
  threshold: number;
  tone: 'skip' | 'accent';
}) {
  return (
    <div className="gate-meter">
      <span className="gate-meter-name">
        <strong>{name}</strong>
        <small className="muted">{note}</small>
      </span>
      <Meter
        label={`${name} score`}
        value={value}
        min={SCALE_MIN}
        threshold={threshold}
        tone={tone}
      />
      <span className="gate-figure">{pct(value)}</span>
    </div>
  );
}

/**
 * The publish gate (handoff §8 after #77): informational, never locked. Tag and title, the
 * Holdout and Dev meters, what lowers the score (EV1 hints, linked to the fixing tab), the
 * threshold, the live version and Publish vN.
 */
export function GateCard({
  api,
  projectId,
  draft,
  published,
  gate,
  publications,
  threshold,
  devScore,
  onChanged,
  onPublished,
}: {
  api: Api;
  projectId: string;
  draft: number | null;
  published: number | null;
  gate: PublishGateView | null;
  /** Newest first. */
  publications: Publication[];
  threshold: ThresholdInfo | null;
  /** Newest complete dev score of the draft with the template's models. */
  devScore: number | null;
  /** The gate or the threshold may have changed: reload them. */
  onChanged: () => void;
  onPublished: () => void;
}) {
  const hintsId = useId();
  const saved = threshold?.value;
  const [text, setText] = useState(saved === undefined ? '' : String(Math.round(saved * 100)));
  useEffect(() => {
    if (saved !== undefined) setText(String(Math.round(saved * 100)));
  }, [saved]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justPublished, setJustPublished] = useState<number | null>(null);

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
  const parsed = parseThreshold(text);
  const save = () =>
    act(async () => {
      if (!('value' in parsed)) return;
      await api.setPublishThreshold(projectId, parsed.value);
      onChanged();
    });
  const publish = () =>
    act(async () => {
      const result = await api.publish(projectId, undefined);
      setJustPublished(result.publication.version);
      onPublished();
      onChanged();
    });

  const tag = gateTag(gate, draft);
  const limit = gate?.threshold ?? saved ?? 0.9;
  const holdout = gate && gate.iterationId !== null ? gate.score : null;
  const live = publications[0] ?? null;
  return (
    <section className="card gate-card" data-tone={tag.tone} aria-label="Publish gate">
      <div className="gate-main">
        <div className="gate-head">
          <span className="gate-tag" data-tone={tag.tone}>
            {tag.label}
          </span>
          <h3>{gateTitle(gate, draft, published)}</h3>
        </div>
        {draft !== null && (
          <>
            <GateMeter
              name="Holdout"
              note="measured against the threshold"
              value={holdout}
              threshold={limit}
              tone="skip"
            />
            <GateMeter
              name="Dev"
              note="guides your changes"
              value={devScore}
              threshold={limit}
              tone="accent"
            />
            <div className="gate-scale" aria-hidden="true">
              <span>70%</span>
              <span>Threshold {pct(limit)}</span>
              <span>100%</span>
            </div>
            <p className="muted gate-optional">
              Evaluation is optional: you can publish v{draft} at any time.
            </p>
          </>
        )}
      </div>
      {draft !== null && (
        <aside className="gate-hints" data-tone={tag.tone} aria-labelledby={hintsId}>
          <h4 id={hintsId}>What&apos;s lowering the score</h4>
          {gate === null ? (
            <p className="muted">Checking the gate…</p>
          ) : gate.iterationId === null ? (
            <p>
              No holdout run of v{draft} yet. Run one below to measure v{draft} against the
              threshold.
            </p>
          ) : gate.hints.length === 0 ? (
            <p>No output is below the threshold.</p>
          ) : (
            <ul>
              {gate.hints.map((h) => (
                <li key={h.key}>
                  {hintText(h)}{' '}
                  <a href={`#/workbench/${projectId}/${h.stage}`}>{HINT_LINK[h.stage]}</a>
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
      <div className="gate-foot">
        <label className="gate-threshold">
          Publish threshold (%){' '}
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={busy || 'error' in parsed}
          title={'error' in parsed ? parsed.error : busy ? 'Saving…' : undefined}
          onClick={() => void save()}
        >
          Save threshold
        </button>
        {threshold?.setBy && threshold.setAt && (
          <small className="muted">
            Threshold set by {threshold.setBy} on {new Date(threshold.setAt).toLocaleDateString()}
          </small>
        )}
        <span className="muted gate-live">
          {live
            ? `Live: v${live.version} ${DOT} published ${new Date(live.publishedAt).toLocaleDateString()} at ${live.score === null ? 'no holdout score' : pct(live.score)}`
            : 'Not published yet'}
        </span>
        {draft !== null && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            title={busy ? 'Working…' : undefined}
            onClick={() => void publish()}
          >
            Publish v{draft}
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {justPublished !== null && <p role="status">Published v{justPublished}</p>}
    </section>
  );
}

/** Every Workbench publication, newest first; overrides (from before #77) in rose. */
export function PublicationsLog({ publications }: { publications: Publication[] }) {
  if (!publications.length) return null;
  return (
    <div className="publications">
      <h4>Publications</h4>
      <ul aria-label="Publications">
        {publications.map((p) => (
          <li key={p.id}>
            <strong>v{p.version}</strong> {DOT} {new Date(p.publishedAt).toLocaleDateString()} {DOT}{' '}
            {pct(p.score)}
            {p.overrideReason && (
              <span className="publication-override">
                {' '}
                {DOT} override: {p.overrideReason}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
