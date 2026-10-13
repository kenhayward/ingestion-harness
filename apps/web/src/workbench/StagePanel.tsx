import { useCallback, useEffect, useState } from 'react';
import {
  changeBodyOf,
  type ChangeStage,
  type DataPolicy,
  type DraftChange,
  type OverviewItem,
  type ProposalView,
  type SampleView,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { ProposalCard, type NextStep } from './ProposalCard.js';
import { TabHeader } from './TabHeader.js';

const PROPOSE: Record<ChangeStage, string> = {
  outputs: 'Propose outputs',
  sections: 'Propose section anchors',
  steps: 'Propose extraction steps',
  revise: 'Propose a revision',
};

const POLICY_NOTE: Record<DataPolicy, string> = {
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
    label: 'Go to Steps',
    text: 'Next, decide which step reads which sections and fills which outputs.',
  },
  steps: {
    tab: 'runs',
    label: 'Run on dev samples',
    text: 'Run the steps on the dev samples to refresh the per-step figures, then verify references.',
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
  onApplied,
  onSkipped,
  canSkip = true,
  title,
  item = null,
  now = Date.now(),
}: {
  api: Api;
  projectId: string;
  stage: ChangeStage;
  dataPolicy: DataPolicy;
  hasDraft: boolean;
  pollMs: number;
  onApplied: () => void;
  onSkipped: () => void;
  /** False for stages the API refuses to skip (revise). */
  canSkip?: boolean;
  /** With a title the panel opens with the tab header (Propose and Skip as its actions). */
  title?: string;
  item?: OverviewItem | null;
  now?: number;
}) {
  const [proposal, setProposal] = useState<ProposalView | null | undefined>(undefined);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [samples, setSamples] = useState<SampleView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const proposalId = proposal?.id;
  const changeCount = body?.changes.length ?? 0;
  useEffect(() => {
    setSelected(new Set(Array.from({ length: changeCount }, (_, i) => i)));
  }, [proposalId, changeCount]);

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

  const run = () => act(async () => setProposal(await api.startStage(projectId, stage)));
  const accept = () =>
    act(async () => {
      if (!proposal) return;
      const chosen = [...selected].sort((a, b) => a - b);
      setProposal(await api.decideProposal(projectId, proposal.id, 'accepted', chosen));
      onApplied();
    });
  const reject = () =>
    act(async () => {
      if (!proposal) return;
      setProposal(await api.decideProposal(projectId, proposal.id, 'rejected'));
    });
  const skip = () =>
    act(async () => {
      await api.skipStage(projectId, stage);
      setMessage('Stage skipped; write this part by hand on the Template tab.');
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
          <TabHeader title={title} item={item ?? null} note={POLICY_NOTE[dataPolicy]} />
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

  const actions = (
    <>
      <button
        type="button"
        className={proposal ? undefined : 'primary'}
        disabled={running || busy || !hasDraft}
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
        <TabHeader title={title} item={item} note={POLICY_NOTE[dataPolicy]} actions={actions} />
      ) : (
        <>
          <p className="muted">{POLICY_NOTE[dataPolicy]}</p>
          <div className="actions">{actions}</div>
        </>
      )}
      {!hasDraft && <p className="muted">Start the next version on the Template tab first.</p>}
      {running && <p className="muted">Drafting…</p>}
      {error && <p role="alert">{error}</p>}
      {proposal?.status === 'failed' && <p role="alert">{proposal.error}</p>}
      {message && <p role="status">{message}</p>}
      {body && proposal && (
        <ProposalCard
          projectId={projectId}
          proposal={proposal}
          body={body}
          definition={null}
          draftVersion={null}
          selected={selected}
          onToggle={toggle}
          onApply={() => void accept()}
          onReject={() => void reject()}
          busy={busy}
          now={now}
          note={anchorLine}
          next={nextStep}
        />
      )}
    </div>
  );
}
