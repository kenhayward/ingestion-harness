import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  applyChanges,
  changeBodyOf,
  type ChangeStage,
  type DataPolicy,
  type DraftChange,
  type OverviewItem,
  type ProposalView,
  type SampleView,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { ModelLogButton } from './DraftLogDialog.js';
import { useModelChoices } from '../ui/ModelPicker.js';
import { DeliveryTargets } from './DeliveryTargets.js';
import { OutputsView } from './OutputsView.js';
import { ProposalCard, type NextStep } from './ProposalCard.js';
import { StaleBanner } from './StaleBanner.js';
import { StepsView } from './StepsView.js';
import { stepCards, type StepMetric } from './steps.js';
import { TabHeader } from './TabHeader.js';
import { DraftRunProgress } from './DraftRunProgress.js';
import { useDefinitions } from './useDefinitions.js';

/** Handoff §0.4 / SC1: what Keep is called and what the banner asks, per stage. */
const KEEP: Record<ChangeStage, { label: string; text: string }> = {
  outputs: {
    label: 'Keep these outputs',
    text: 'Check the outputs below, then keep them as they are or propose again; the draft keeps what you applied until you apply new changes.',
  },
  sections: {
    label: 'Keep these anchors',
    text: 'The anchors may still work: check where they land below, then keep them or let the model propose new ones.',
  },
  steps: {
    label: 'Keep this pipeline',
    text: 'Check the pipeline below, then keep it as it is or propose again.',
  },
  revise: { label: 'Keep', text: '' }, // revise is never stale (not in STAGE_ORDER)
  mapping: {
    label: 'Keep this mapping',
    text: "The outputs or the brief's ontologies changed since this mapping: check it below, then keep it or ask for a new one.",
  },
};

const DESCRIPTION: Record<ChangeStage, string | undefined> = {
  outputs:
    'The fields and tables every document of this type produces. The model proposes them from the brief and survey; you choose which to apply.',
  sections:
    'Each section starts at the first match of its anchor (a multiline regular expression) and runs to the next. The grid shows, live, where every anchor lands in each prepared sample.',
  steps:
    'Each step sends some sections of the text to a model and fills some outputs; check steps compare values.',
  revise: undefined,
  mapping:
    "Which ontology term each output becomes in the document's graph. The model chooses from terms the brief's ontologies offer; you choose which to apply.",
};

const PROPOSE: Record<ChangeStage, string> = {
  outputs: 'Propose outputs',
  sections: 'Propose section anchors',
  steps: 'Propose a pipeline',
  revise: 'Propose a revision',
  mapping: 'Propose a mapping',
};

export const POLICY_NOTE: Record<DataPolicy, string> = {
  local: 'Runs on local models; holdout samples are never sent.',
  external:
    'Dev sample text may be sent to an external model provider; holdout samples are never sent.',
};

/** What follows an applied proposal (handoff §0.2: "usually a link to the next tab"). */
const NEXT: Record<ChangeStage, { tab: string; label: string; text: string }> = {
  outputs: {
    tab: 'sections',
    label: 'Go to Sections',
    text: 'Next, check where each section starts in the dev samples.',
  },
  sections: {
    tab: 'steps',
    label: 'Go to Pipeline',
    text: 'Next, decide which step reads which sections and fills which outputs.',
  },
  steps: {
    tab: 'runs',
    label: 'Run on dev samples',
    text: "Run the steps on the dev samples to refresh the per-step figures. Test runs aren't scored: Evaluate on dev scores the draft against your verified references.",
  },
  mapping: {
    tab: 'mapping',
    label: 'Preview the graph',
    text: 'Preview the graph of a dev sample to check the mapping on real values.',
  },
  revise: {
    tab: 'evaluate',
    label: 'Evaluate on dev',
    text: 'Evaluate the revised draft on the dev samples to see whether it helped.',
  },
};

/** Drafting stages 2-4 (ADR 0007): propose changes to the draft, apply the chosen ones. */
export function StagePanel({
  api,
  projectId,
  stage,
  dataPolicy,
  hasDraft,
  pollMs,
  retired = null,
  onApplied,
  onConfirmed,
  onSkipped,
  draft,
  published = null,
  briefVersion = null,
  canSkip = true,
  blockedReason = null,
  title,
  item = null,
  now = Date.now(),
  changeNote,
  changeBadge,
}: {
  api: Api;
  projectId: string;
  stage: ChangeStage;
  dataPolicy: DataPolicy;
  hasDraft: boolean;
  pollMs: number;
  /** Why job-creating actions are off (a retired document type); null when they are not. */
  retired?: string | null;
  onApplied: () => void;
  /**
   * After Keep on a stale stage; defaults to `onApplied`. The draft is unchanged, so the sections
   * tab passes a lighter reload.
   */
  onConfirmed?: () => void;
  onSkipped: () => void;
  /** Outputs/Pipeline: the open draft and live versions shown beside the proposal; omit to hide. */
  draft?: number | null;
  published?: number | null;
  /** The project's current brief version (stale-proposal banner). */
  briefVersion?: number | null;
  /** False for stages the API refuses to skip (revise). */
  canSkip?: boolean;
  /** Keep and Apply are disabled with this reason (the Sections tab has unsaved anchors). */
  blockedReason?: string | null;
  /** With a title the panel opens with the tab header (Propose and Skip as its actions). */
  title?: string;
  item?: OverviewItem | null;
  now?: number;
  /** A line under each change (the mapping stage: values seen, alternatives). */
  changeNote?: (c: DraftChange) => string | null;
  /** A tag beside each change (the mapping stage: the model's confidence). */
  changeBadge?: (c: DraftChange, index: number) => ReactNode;
}) {
  const [proposal, setProposal] = useState<ProposalView | null | undefined>(undefined);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [samples, setSamples] = useState<SampleView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [metrics, setMetrics] = useState<StepMetric[] | null>(null);
  const [justAdded, setJustAdded] = useState<ReadonlySet<string>>(new Set());

  const models = useModelChoices(api);
  const showsDefinition = (stage === 'outputs' || stage === 'steps') && typeof draft === 'number';
  const definitions = useDefinitions(
    api,
    projectId,
    typeof draft === 'number' ? draft : null,
    stage === 'outputs' ? published : null,
    showsDefinition,
  );
  const draftDef = showsDefinition ? definitions.draftDef : null;

  const refresh = useCallback(async () => {
    try {
      const all = await api.listProposals(projectId);
      setProposal(all.find((p) => p.stage === stage) ?? null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId, stage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const body = proposal ? changeBodyOf(proposal) : null;
  const running = proposal?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [running, pollMs, refresh]);

  // A new proposal starts with every change selected. Reset during render (not in an effect), so
  // no frame shows its checkboxes unchecked: a slow machine could see one before an effect ran.
  const changeCount = body?.changes.length ?? 0;
  const selectionKey = `${proposal?.id ?? ''}:${changeCount}`;
  const [selectedFor, setSelectedFor] = useState(selectionKey);
  if (selectedFor !== selectionKey) {
    setSelectedFor(selectionKey);
    setSelected(new Set(Array.from({ length: changeCount }, (_, i) => i)));
  }

  useEffect(() => {
    if (stage !== 'sections') return;
    api.listSamples(projectId).then(setSamples, () => setSamples([]));
  }, [api, projectId, stage]);

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

  useEffect(() => {
    if (stage !== 'steps' || typeof draft !== 'number') return;
    let live = true;
    api.getMetrics(projectId).then(
      (m) => {
        if (live) setMetrics(m.steps);
      },
      () => {
        if (live) setMetrics(null);
      },
    );
    return () => {
      live = false;
    };
  }, [api, projectId, stage, draft]);

  const keep = () =>
    act(async () => {
      if (stage === 'revise') return;
      await api.confirmStage(projectId, stage);
      setMessage(`Kept as it is; ${(title ?? stage).toLowerCase()} is up to date again.`);
      (onConfirmed ?? onApplied)();
    });
  const run = () =>
    act(async () => {
      setJustAdded(new Set());
      setProposal(await api.startStage(projectId, stage));
    });
  const accept = () =>
    act(async () => {
      if (!proposal) return;
      const before = new Set(stepCards(draftDef ?? {}).map((c) => c.id));
      const chosen = [...selected].sort((a, b) => a - b);
      setProposal(await api.decideProposal(projectId, proposal.id, 'accepted', chosen));
      onApplied();
      const reloaded = await definitions.reload();
      if (reloaded && draftDef) {
        setJustAdded(
          new Set(
            stepCards(reloaded)
              .map((c) => c.id)
              .filter((id) => !before.has(id)),
          ),
        );
      }
    });
  const reject = () =>
    act(async () => {
      if (!proposal) return;
      setProposal(await api.decideProposal(projectId, proposal.id, 'rejected'));
    });
  const skip = () =>
    act(async () => {
      await api.skipStage(projectId, stage);
      setMessage('Stage skipped; write this part by hand on the Recipe tab.');
      onSkipped();
    });

  const toggle = (i: number) => {
    const next = new Set(selected);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setSelected(next);
  };

  const anchorLine = (c: DraftChange): string | null => {
    if (c.op !== 'putSection' || !body?.anchorCheck) return null;
    const rows = body.anchorCheck.samples.filter((r) => !r.error);
    const name = (id: string) => samples.find((s) => s.id === id)?.filename ?? id;
    const missed = rows.filter((r) => !r.sections.some((s) => s.id === c.section.id && s.found));
    const found = rows.length - missed.length;
    return `found in ${found} of ${rows.length} dev samples${missed.length ? ` (missed: ${missed.map((r) => name(r.sampleId)).join(', ')})` : ''}`;
  };

  if (proposal === undefined) {
    return (
      <div>
        {title !== undefined && (
          <TabHeader
            title={title}
            item={item ?? null}
            note={POLICY_NOTE[dataPolicy]}
            description={DESCRIPTION[stage]}
          />
        )}
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button type="button" onClick={() => void refresh()}>
              Retry
            </button>
          </>
        ) : (
          <p>Loading…</p>
        )}
      </div>
    );
  }
  const nextStep: NextStep = {
    href: `#/workbench/${projectId}/${NEXT[stage].tab}`,
    label: NEXT[stage].label,
    text: NEXT[stage].text,
  };

  const after =
    proposal?.status === 'ready' && body && draftDef
      ? applyChanges(
          draftDef,
          body.changes.filter((_, i) => selected.has(i)),
        )
      : null;

  const card =
    body && proposal ? (
      <ProposalCard
        api={api}
        models={models}
        projectId={projectId}
        proposal={proposal}
        body={body}
        definition={draftDef}
        draftVersion={typeof draft === 'number' ? draft : null}
        selected={selected}
        onToggle={toggle}
        onApply={() => void accept()}
        onReject={() => void reject()}
        busy={busy}
        applyBlockedReason={blockedReason}
        now={now}
        note={changeNote ?? anchorLine}
        badge={changeBadge}
        next={nextStep}
      />
    ) : null;

  const actions = (
    <>
      <button
        type="button"
        className={proposal ? undefined : 'primary'}
        disabled={running || busy || !hasDraft || retired !== null}
        title={retired ?? undefined}
        onClick={() => void run()}
      >
        {proposal ? 'Propose again' : PROPOSE[stage]}
      </button>
      {canSkip && (
        <button type="button" disabled={busy} onClick={() => void skip()}>
          Skip this stage
        </button>
      )}
    </>
  );

  return (
    <div className="stage-panel">
      {title !== undefined ? (
        <TabHeader
          title={title}
          item={item}
          note={POLICY_NOTE[dataPolicy]}
          description={DESCRIPTION[stage]}
          actions={actions}
        />
      ) : (
        <>
          <p className="muted">{POLICY_NOTE[dataPolicy]}</p>
          <div className="actions">{actions}</div>
        </>
      )}
      {!hasDraft && <p className="muted">Start the next version on the Recipe tab first.</p>}
      {running && (
        <DraftRunProgress
          stage={stage}
          run={proposal.run}
          label="Drafting progress"
          fallback={<p className="muted">Drafting…</p>}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {proposal?.status === 'failed' && (
        <p role="alert">
          {proposal.error}{' '}
          <ModelLogButton api={api} projectId={projectId} proposalId={proposal.id} />
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {title !== undefined && item?.state === 'stale' && stage !== 'revise' && (
        <StaleBanner
          onKeep={() => void keep()}
          keepLabel={KEEP[stage].label}
          busy={busy}
          keepBlockedReason={blockedReason}
        >
          {item.status}. {KEEP[stage].text}
        </StaleBanner>
      )}
      {title !== undefined &&
        proposal?.briefVersion != null &&
        briefVersion !== null &&
        briefVersion > proposal.briefVersion && (
          <StaleBanner tone="info">
            This proposal used brief v{proposal.briefVersion}; the brief is now v{briefVersion}.
            Propose again to draft from the latest brief; what you applied stays in the draft until
            you apply new changes.
          </StaleBanner>
        )}
      {showsDefinition && definitions.error && (
        <p role="alert">
          Could not load draft v{draft}: {definitions.error}
        </p>
      )}
      {stage === 'outputs' && draftDef && definitions.liveError && (
        <p role="alert">
          Could not load live v{published}: {definitions.liveError}
        </p>
      )}
      {stage === 'outputs' && draftDef && typeof draft === 'number' ? (
        <>
          {proposal?.status === 'ready' && card}
          <DeliveryTargets
            api={api}
            projectId={projectId}
            draftVersion={draft}
            definition={draftDef}
            updatedAt={definitions.draftUpdatedAt}
            onSaved={() => {
              void definitions.reload();
              onApplied();
            }}
          />
          <OutputsView
            draftVersion={draft}
            liveVersion={definitions.liveDef ? published : null}
            draftDef={draftDef}
            liveDef={definitions.liveDef}
          />
          {proposal?.status !== 'ready' && card}
        </>
      ) : stage === 'steps' && draftDef && typeof draft === 'number' ? (
        <StepsView
          models={models}
          projectId={projectId}
          draftVersion={draft}
          definition={draftDef}
          after={after}
          metrics={metrics}
          justAdded={justAdded}
          card={card}
        />
      ) : (
        card
      )}
    </div>
  );
}
