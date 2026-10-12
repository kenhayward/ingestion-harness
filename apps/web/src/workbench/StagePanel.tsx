import { useCallback, useEffect, useState } from 'react';
import {
  changeBodyOf,
  type ChangeStage,
  type DataPolicy,
  type DraftChange,
  type ProposalView,
  type SampleView,
} from '@ih/shared';
import type { Api } from '../api/client.js';

const PROPOSE: Record<ChangeStage, string> = {
  outputs: 'Propose outputs',
  sections: 'Propose section anchors',
  steps: 'Propose extraction steps',
};

const POLICY_NOTE: Record<DataPolicy, string> = {
  local: 'Runs on local models; holdout samples are never sent.',
  external:
    'Dev sample text may be sent to an external model provider; holdout samples are never sent.',
};

/** One line per change, used as its checkbox label. */
export function describeChange(c: DraftChange): string {
  switch (c.op) {
    case 'putField':
      return `Field ${c.field.id} (${c.field.type}${c.field.type === 'enum' ? `: ${(c.field.enum ?? []).join(', ')}` : ''})`;
    case 'putTable':
      return `Table ${c.table.id} (${c.table.columns.map((col) => col.id).join(', ')})`;
    case 'removeOutput':
      return `Remove output ${c.id}`;
    case 'putSection':
      return `Section ${c.section.id}: /${c.section.anchor}/${c.section.required ? '' : ' (optional)'}`;
    case 'removeSection':
      return `Remove section ${c.id}`;
    case 'setCopies':
      return c.copies
        ? `Keep the ${c.copies.select} copy, split at /${c.copies.anchor}/`
        : 'No copy selection';
    case 'putStep':
      return c.step.type === 'extract'
        ? `Extract step ${c.step.id}: ${c.step.table ? `table ${c.step.table}` : c.step.fields.join(', ')} from ${c.step.sections.join(', ')}`
        : `Check step ${c.step.id}: ${c.step.values} against ${c.step.reference}`;
    case 'removeStep':
      return `Remove step ${c.id}`;
    case 'setPreamble':
      return c.preamble ? 'Set the prompt preamble' : 'Remove the prompt preamble';
  }
}

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
}: {
  api: Api;
  projectId: string;
  stage: ChangeStage;
  dataPolicy: DataPolicy;
  hasDraft: boolean;
  pollMs: number;
  onApplied: () => void;
  onSkipped: () => void;
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
    return error ? (
      <div>
        <p role="alert">{error}</p>
        <button type="button" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    ) : (
      <p>Loading…</p>
    );
  }
  const applied = proposal?.acceptedChanges ?? null;

  return (
    <div className="stage-panel">
      <p className="muted">{POLICY_NOTE[dataPolicy]}</p>
      {!hasDraft && <p className="muted">Start the next version on the Template tab first.</p>}
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={running || busy || !hasDraft}
          onClick={() => void run()}
        >
          {proposal ? 'Propose again' : PROPOSE[stage]}
        </button>
        <button type="button" disabled={busy} onClick={() => void skip()}>
          Skip this stage
        </button>
      </div>
      {running && <p className="muted">Drafting…</p>}
      {error && <p role="alert">{error}</p>}
      {proposal?.status === 'failed' && <p role="alert">{proposal.error}</p>}
      {message && <p role="status">{message}</p>}
      {body && proposal && (
        <section aria-label="Proposal">
          <p className="muted">
            {proposal.model} · brief v{proposal.briefVersion ?? '–'} ·{' '}
            {proposal.status.replace('_', ' ')}
          </p>
          {body.notes && <p>{body.notes}</p>}
          {applied && (
            <p role="status">
              {applied.length} of {body.changes.length} changes applied to the draft
            </p>
          )}
          <ul className="changes">
            {body.changes.map((c, i) => {
              const line = anchorLine(c);
              return (
                <li key={`${i}-${c.op}`}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={proposal.status !== 'ready'}
                      checked={
                        proposal.status === 'ready' ? selected.has(i) : (applied ?? []).includes(i)
                      }
                      onChange={() => toggle(i)}
                    />{' '}
                    {describeChange(c)}
                  </label>
                  <small className="muted"> {c.reason}</small>
                  {line && <p className="muted">{line}</p>}
                  <details>
                    <summary>Details</summary>
                    <pre>{JSON.stringify(c, null, 2)}</pre>
                  </details>
                </li>
              );
            })}
          </ul>
          {proposal.status === 'ready' && (
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={busy || selected.size === 0}
                onClick={() => void accept()}
              >
                Apply selected changes
              </button>
              <button type="button" disabled={busy} onClick={() => void reject()}>
                Reject all
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
