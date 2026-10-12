import { useCallback, useEffect, useState } from 'react';
import type { Brief, DataPolicy, ProposalView } from '@ih/shared';
import { EMPTY_BRIEF, surveyBodyOf } from '@ih/shared';
import type { Api } from '../api/client.js';

const POLICY_NOTE: Record<DataPolicy, string> = {
  local: 'Runs on local models; holdout samples are never sent.',
  external:
    'Dev sample text may be sent to an external model provider; holdout samples are never sent.',
};

/** Drafting stage 1: the model surveys the dev samples and asks questions (ADR 0007). */
export function SurveyTab({
  api,
  projectId,
  dataPolicy,
  brief,
  onBriefSaved,
  pollMs,
  onChanged,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  brief: Brief | null;
  onBriefSaved: (brief: Brief) => void;
  pollMs: number;
  /** Called after a decision or a skip, so the page can reload stage states. */
  onChanged?: () => void;
}) {
  const [proposal, setProposal] = useState<ProposalView | null | undefined>(undefined);
  /** Answers typed in this session, by question; unedited questions show the brief's answer. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await api.listProposals(projectId);
      setProposal(all.find((p) => p.stage === 'survey') ?? null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const proposalId = proposal?.id;
  useEffect(() => {
    setTyped({});
  }, [proposalId]);

  const running = proposal?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [running, pollMs, refresh]);

  const act = async (action: () => Promise<void>) => {
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const run = () =>
    act(async () => {
      setProposal(await api.startStage(projectId, 'survey'));
    });

  const decide = (decision: 'accepted' | 'rejected') =>
    act(async () => {
      if (!proposal) return;
      setProposal(await api.decideProposal(projectId, proposal.id, decision));
      onChanged?.();
    });

  const skip = () =>
    act(async () => {
      await api.skipStage(projectId, 'survey');
      setMessage('Survey skipped');
      onChanged?.();
    });

  const briefAnswers = brief?.body.answers ?? [];
  const briefAnswer = (question: string) =>
    briefAnswers.find((qa) => qa.question === question)?.answer ?? '';
  // Only the displayed questions whose typed answer is non-empty and differs from the brief's.
  const given = (proposal ? (surveyBodyOf(proposal)?.questions ?? []) : [])
    .map((q) => [q.question, (typed[q.question] ?? '').trim()] as const)
    .filter(([q, a]) => a !== '' && a !== briefAnswer(q));

  const saveAnswers = () =>
    act(async () => {
      const body = brief?.body ?? EMPTY_BRIEF;
      const kept = body.answers.filter((qa) => !given.some(([q]) => q === qa.question));
      const saved = await api.saveBrief(projectId, {
        ...body,
        answers: [...kept, ...given.map(([question, answer]) => ({ question, answer }))],
      });
      onBriefSaved(saved);
      setTyped({});
      setMessage(`Answers saved to brief version ${saved.version}`);
    });

  if (proposal === undefined) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;
  const body = proposal ? surveyBodyOf(proposal) : null;

  return (
    <div className="survey-tab">
      <p className="muted">{POLICY_NOTE[dataPolicy]}</p>
      <button type="button" className="primary" disabled={running} onClick={() => void run()}>
        {proposal ? 'Run survey again' : 'Run survey'}
      </button>
      <button type="button" disabled={running} onClick={() => void skip()}>
        Skip this stage
      </button>
      {running && <span className="muted"> Surveying the dev samples…</span>}
      {error && <p role="alert">{error}</p>}
      {proposal?.status === 'failed' && <p role="alert">{proposal.error}</p>}
      {message && <p role="status">{message}</p>}
      {body && proposal && (
        <section aria-label="Survey">
          <p className="muted">
            {proposal.model} · brief v{proposal.briefVersion ?? '–'} · {proposal.status}
          </p>
          <h3>Summary</h3>
          <p>{body.summary}</p>
          <h3>Structure</h3>
          <ol>
            {body.structure.map((s, i) => (
              <li key={`${i}:${s.name}`}>
                <strong>{s.name}</strong>: {s.description}{' '}
                <small className="muted">({s.howToFind})</small>
              </li>
            ))}
          </ol>
          <h3>Variants</h3>
          <ul>
            {body.variants.map((v, i) => (
              <li key={`${i}:${v}`}>{v}</li>
            ))}
          </ul>
          <table aria-label="Candidate data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>What</th>
                <th>Where</th>
              </tr>
            </thead>
            <tbody>
              {body.candidates.map((c, i) => (
                <tr key={`${i}:${c.name}`}>
                  <td>
                    <code>{c.name}</code>
                  </td>
                  <td>{c.kind}</td>
                  <td>{c.description}</td>
                  <td>{c.where}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {body.questions.length > 0 && (
            <>
              <h3>Questions</h3>
              {body.questions.map((q, i) => (
                <div key={`${i}:${q.question}`} className="question">
                  <p>
                    {q.question} <small className="muted">{q.why}</small>
                  </p>
                  <textarea
                    aria-label={q.question}
                    rows={2}
                    value={typed[q.question] ?? briefAnswer(q.question)}
                    onChange={(e) => setTyped({ ...typed, [q.question]: e.target.value })}
                  />
                </div>
              ))}
              <button
                type="button"
                disabled={given.length === 0}
                onClick={() => void saveAnswers()}
              >
                Save answers to brief
              </button>
            </>
          )}
          {proposal.status === 'ready' && (
            <div className="actions">
              <button type="button" className="primary" onClick={() => void decide('accepted')}>
                Accept
              </button>
              <button type="button" onClick={() => void decide('rejected')}>
                Reject
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
