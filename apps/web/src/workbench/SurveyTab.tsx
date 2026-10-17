import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EMPTY_BRIEF,
  candidateInBrief,
  surveyBodyOf,
  type Brief,
  type BriefBody,
  type DataPolicy,
  type OverviewItem,
  type ProposalView,
  type StageView,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { ModelLogButton } from './DraftLogDialog.js';
import { draftingModelName, relativeTime } from '../jobs/derive.js';
import { useModelChoices } from '../ui/ModelPicker.js';
import { Icon } from '../ui/Icon.js';
import { SurveyOntologies } from './SurveyOntologies.js';
import { keepDraft, loadKept, stringRecord } from '../ui/keptDraft.js';
import { Meter } from '../ui/Meter.js';
import { StageStatusIcon } from '../ui/StageStatusIcon.js';
import { StaleBanner } from './StaleBanner.js';
import { TabHeader } from './TabHeader.js';
import { DraftRunProgress } from './DraftRunProgress.js';
import {
  answerProgress,
  candidateCounts,
  saveAnswersLabel,
  seenInText,
  skipBanner,
  skipBannerText,
} from './survey.js';

const POLICY_NOTE: Record<DataPolicy, string> = {
  local: 'Runs on local models; holdout samples are never sent.',
  external:
    'Dev sample text may be sent to an external model provider; holdout samples are never sent.',
};

/** The tabs within the Survey tab, in order; a route may name one (`survey/ontologies`). */
const SURVEY_VIEWS = ['findings', 'questions', 'candidates', 'ontologies'] as const;
type SurveyView = (typeof SURVEY_VIEWS)[number];
const VIEW_LABEL: Record<SurveyView, string> = {
  findings: 'Findings',
  questions: 'Questions',
  candidates: 'Candidates',
  ontologies: 'Ontologies',
};
const surveyView = (view: string | undefined): SurveyView =>
  SURVEY_VIEWS.find((v) => v === view) ?? 'findings';

const DESCRIPTION =
  'The model reads the ready dev samples and describes what it found, then asks about anything the brief leaves open.';

/** Drafting stage 1 (handoff §3): the model surveys the dev samples and asks questions. */
export function SurveyTab({
  api,
  projectId,
  dataPolicy,
  brief,
  onBriefSaved,
  pollMs,
  retired = null,
  onChanged,
  item = null,
  now = Date.now(),
  view,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  brief: Brief | null;
  onBriefSaved: (brief: Brief) => void;
  pollMs: number;
  /** Why job-creating actions are off (a retired document type); null when they are not. */
  retired?: string | null;
  /** Called after a decision or a skip, so the page can reload stage states. */
  onChanged?: () => void;
  /** The overview item: the header's status line (same text as the rail). */
  item?: OverviewItem | null;
  now?: number;
  /** The tab to open (`findings` by default), from the route. */
  view?: string;
}) {
  const models = useModelChoices(api);
  const [proposal, setProposal] = useState<ProposalView | null | undefined>(undefined);
  const [stages, setStages] = useState<StageView[]>([]);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<SurveyView>(() => surveyView(view));
  // A link to another tab while this one is open (Brief's "Change on Survey").
  const [viewFor, setViewFor] = useState(view);
  if (view !== viewFor) {
    setViewFor(view);
    setShown(surveyView(view));
  }

  const refresh = useCallback(async () => {
    try {
      const [all, states] = await Promise.all([
        api.listProposals(projectId),
        api.listStages(projectId),
      ]);
      setProposal(all.find((p) => p.stage === 'survey') ?? null);
      setStages(states);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const proposalId = proposal?.id;
  /** Answers typed for this proposal but not saved, kept in this browser (ui/keptDraft.ts). */
  const answersKey = proposalId ? `ih.surveyAnswers.${projectId}.${proposalId}` : null;
  const [restored, setRestored] = useState(false);
  // Another proposal's questions: start from its kept answers, if any (set while rendering, so
  // the boxes never show empty first).
  const [typedFor, setTypedFor] = useState<string | null>(null);
  if (answersKey !== typedFor) {
    setTypedFor(answersKey);
    const kept = answersKey ? loadKept(answersKey, stringRecord) : null;
    setTyped(kept?.value ?? {});
    setRestored(kept !== null);
  }

  const running = proposal?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [running, pollMs, refresh]);

  // One brief save at a time on this tab: answers and ontology pins both write a whole brief
  // built from the same version, so a second save in flight would undo the first.
  const briefLock = useRef(false);
  const [briefBusy, setBriefBusy] = useState(false);
  const saveBriefBody = useCallback(
    async (next: BriefBody): Promise<Brief | null> => {
      if (briefLock.current) return null;
      briefLock.current = true;
      setBriefBusy(true);
      try {
        const saved = await api.saveBrief(projectId, next);
        onBriefSaved(saved);
        return saved;
      } finally {
        briefLock.current = false;
        setBriefBusy(false);
      }
    },
    [api, projectId, onBriefSaved],
  );

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

  const body = proposal ? surveyBodyOf(proposal) : null;
  const saved = brief?.body.answers ?? [];
  const progress = body ? answerProgress(body.questions, saved, typed) : null;
  const unsavedAnswers = (progress?.unsaved.length ?? 0) > 0;
  useEffect(() => {
    if (!answersKey) return;
    keepDraft(answersKey, unsavedAnswers ? { base: brief?.version ?? null, value: typed } : null);
  }, [answersKey, unsavedAnswers, typed, brief?.version]);
  const banner = skipBanner(stages, proposal ?? null);
  const savedAnswer = (q: string) => saved.find((a) => a.question === q)?.answer ?? '';

  const run = () => act(async () => setProposal(await api.startStage(projectId, 'survey')));
  const decide = (decision: 'accepted' | 'rejected') =>
    act(async () => {
      if (!proposal) return;
      setProposal(await api.decideProposal(projectId, proposal.id, decision));
      setStages(await api.listStages(projectId));
      onChanged?.();
    });
  const skip = () =>
    act(async () => {
      await api.skipStage(projectId, 'survey');
      setMessage('Survey skipped');
      void refresh();
      onChanged?.();
    });
  const saveAnswers = () =>
    act(async () => {
      if (!progress?.unsaved.length) return;
      const base = brief?.body ?? EMPTY_BRIEF;
      const kept = base.answers.filter(
        (qa) => !progress.unsaved.some((u) => u.question === qa.question),
      );
      const next = await saveBriefBody({
        ...base,
        answers: [...kept, ...progress.unsaved.filter((u) => u.answer !== '')],
      });
      if (!next) return;
      setTyped({});
      setMessage(`Answers saved to brief version ${next.version}`);
    });

  const actions = (
    <>
      <button
        type="button"
        className={proposal ? undefined : 'primary'}
        disabled={running || busy || unsavedAnswers || retired !== null}
        title={retired ?? (unsavedAnswers ? 'Save your answers first' : undefined)}
        onClick={() => void run()}
      >
        {proposal ? 'Run again' : 'Run survey'}
      </button>
      <button type="button" disabled={running || busy} onClick={() => void skip()}>
        Skip this stage
      </button>
    </>
  );
  const header = (
    <TabHeader
      title="Survey"
      item={item}
      description={DESCRIPTION}
      note={POLICY_NOTE[dataPolicy]}
      actions={actions}
    />
  );

  if (proposal === undefined) {
    return (
      <div className="survey-tab">
        {header}
        {error ? <p role="alert">{error}</p> : <p>Loading…</p>}
      </div>
    );
  }

  const notRun = !body && !running;
  const tabCount = (v: SurveyView) => {
    if (!body || !progress) return null;
    if (v === 'questions' && progress.of > 0) {
      return {
        text: `${progress.answered}/${progress.of}`,
        tone: progress.answered < progress.of ? 'warn' : null,
      };
    }
    if (v === 'candidates') return { text: String(body.candidates.length), tone: null };
    return null;
  };
  const panel = (v: SurveyView) => ({
    role: 'tabpanel',
    id: `survey-panel-${v}`,
    'aria-labelledby': `survey-tab-${v}`,
    hidden: shown !== v,
    className: `survey-panel survey-panel-${v}`,
  });

  return (
    <div className="survey-tab">
      {header}
      {running && (
        <DraftRunProgress
          stage="survey"
          run={proposal.run}
          label="Survey progress"
          fallback={<p className="muted">Surveying the dev samples…</p>}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {proposal?.status === 'failed' && (
        <p role="alert">
          {proposal.error}{' '}
          <ModelLogButton api={api} projectId={projectId} proposalId={proposal.id} />
        </p>
      )}
      {restored && unsavedAnswers && (
        <p role="status" className="kept-note">
          <Icon name="info" size={14} />
          Restored your unsaved answers from your last visit.
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {banner && <StaleBanner tone="skip">{skipBannerText(banner)}</StaleBanner>}
      {proposal?.status === 'accepted' && (
        <p className="survey-next">
          Survey accepted. <a href={`#/workbench/${projectId}/outputs`}>Go to Outputs</a> to turn
          the candidates into fields and tables.
        </p>
      )}
      <div role="tablist" aria-label="Survey" className="survey-tabs">
        {SURVEY_VIEWS.map((v) => {
          const count = tabCount(v);
          return (
            <button
              key={v}
              type="button"
              role="tab"
              id={`survey-tab-${v}`}
              aria-controls={`survey-panel-${v}`}
              aria-selected={shown === v}
              onClick={() => setShown(v)}
            >
              {VIEW_LABEL[v]}
              {count && (
                <span className={`tab-count${count.tone ? ` tone-${count.tone}` : ''}`}>
                  {count.text}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div {...panel('findings')}>
        {notRun && (
          <p className="muted">Run the survey to see what the model finds in the dev samples.</p>
        )}
        {body && proposal && (
          <div className="survey-layout">
            <section className="card survey-found" aria-labelledby="survey-found-title">
              <div className="survey-card-head">
                <h3 id="survey-found-title">What the model found</h3>
                <span className="muted survey-meta">
                  {proposal.model === null ? 'model' : draftingModelName(proposal.model, models)} ·
                  brief v{proposal.briefVersion ?? '–'} · {relativeTime(proposal.createdAt, now)}
                </span>
                <ModelLogButton api={api} projectId={projectId} proposalId={proposal.id} />
              </div>
              <p>{body.summary}</p>
              {body.variants.length > 0 && (
                <>
                  <h4>Variants it noticed</h4>
                  <ul className="variant-chips">
                    {body.variants.map((v, i) => (
                      <li key={`${i}:${v}`}>{v}</li>
                    ))}
                  </ul>
                </>
              )}
            </section>
            <aside className="card survey-anatomy" aria-labelledby="survey-anatomy-title">
              <h3 id="survey-anatomy-title">Document anatomy</h3>
              <p className="muted">
                The structure the model found, top to bottom — the Sections stage turns it into
                anchors.
              </p>
              <ol className="anatomy-list">
                {body.structure.map((s, i) => (
                  <li key={`${i}:${s.name}`} className="anatomy-card">
                    <span className="anatomy-number" aria-hidden="true">
                      {i + 1}
                    </span>
                    <div>
                      <strong>{s.name}</strong>
                      <p>{s.description}</p>
                      <p className="muted anatomy-find">Find it: {s.howToFind}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </aside>
          </div>
        )}
      </div>

      <div {...panel('questions')}>
        {notRun && (
          <p className="muted">
            Run the survey to see the questions the model asks about the brief.
          </p>
        )}
        {body && progress && body.questions.length === 0 && (
          <p className="muted">The model has no questions: the brief covers what it found.</p>
        )}
        {body && progress && body.questions.length > 0 && (
          <section className="card survey-questions" aria-labelledby="survey-questions-title">
            <div className="survey-card-head">
              <h3 id="survey-questions-title">Questions from the model</h3>
              <span className="tone-text-warn">
                {progress.answered} of {progress.of} answered
              </span>
              <Meter
                label={`Answered ${progress.answered} of ${progress.of}`}
                value={progress.of ? progress.answered / progress.of : 0}
                tone="warn"
              />
            </div>
            <ol className="survey-question-list">
              {body.questions.map((q, i) => {
                const value = typed[q.question] ?? savedAnswer(q.question);
                const done = value.trim() !== '';
                return (
                  <li key={`${i}:${q.question}`} className="survey-question">
                    <span
                      className={`question-number tone-${done ? 'ok' : 'warn'}`}
                      aria-hidden="true"
                    >
                      {i + 1}
                    </span>
                    <div className="survey-question-body">
                      <p className="question-text">{q.question}</p>
                      <p className="muted question-why">Why it asks: {q.why}</p>
                      <textarea
                        aria-label={q.question}
                        rows={2}
                        placeholder="Your answer — saved to the brief"
                        value={value}
                        onChange={(e) => setTyped({ ...typed, [q.question]: e.target.value })}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="survey-card-foot">
              <button
                type="button"
                disabled={progress.unsaved.length === 0 || busy || briefBusy}
                title={progress.unsaved.length === 0 ? 'Type an answer first' : undefined}
                onClick={() => void saveAnswers()}
              >
                {saveAnswersLabel(progress.unsaved.length, (brief?.version ?? 0) + 1)}
              </button>
              <span className="muted">
                Saving creates a new brief version; unanswered questions can wait.
              </span>
            </div>
          </section>
        )}
      </div>

      <div {...panel('candidates')}>
        {notRun && (
          <p className="muted">Run the survey to see the data the model proposes to extract.</p>
        )}
        {body && (
          <section className="card survey-candidates" aria-labelledby="survey-candidates-title">
            <div className="survey-card-head">
              <h3 id="survey-candidates-title">Candidate data</h3>
              <span className="muted">
                {candidateCounts(body.candidates)} · the Outputs stage turns these into fields and
                tables
              </span>
            </div>
            <div className="table-scroll">
              <table aria-label="Candidate data">
                <thead>
                  <tr>
                    <th scope="col" className="fit">
                      Kind
                    </th>
                    <th scope="col" className="fit">
                      Name
                    </th>
                    <th scope="col">What</th>
                    <th scope="col">Where</th>
                    <th scope="col" className="fit">
                      In brief
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {body.candidates.map((c, i) => {
                    const seen = seenInText(c.seenIn);
                    const inBrief = candidateInBrief(c.name, brief?.body ?? null);
                    return (
                      <tr key={`${i}:${c.name}`}>
                        <td className="fit">
                          <span className={`kind-tag tone-${c.kind === 'table' ? 'ok' : 'info'}`}>
                            {c.kind === 'table' ? 'TABLE' : 'FIELD'}
                          </span>
                        </td>
                        <td className="fit">
                          <code>{c.name}</code>
                        </td>
                        <td>{c.description}</td>
                        <td>
                          {c.where}
                          {seen && ` — ${seen}`}
                        </td>
                        <td className={`fit ${inBrief ? 'tone-text-ok' : 'tone-text-warn'}`}>
                          <StageStatusIcon
                            state={inBrief ? 'accepted' : 'proposed'}
                            size={14}
                            decorative
                          />{' '}
                          {inBrief ? 'Yes' : 'Not yet'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      {/* Kept mounted while hidden, like every panel: its suggestions and unsaved guidance stay. */}
      <div {...panel('ontologies')}>
        <SurveyOntologies
          api={api}
          projectId={projectId}
          dataPolicy={dataPolicy}
          brief={brief}
          onBriefSaved={onBriefSaved}
          saveBrief={saveBriefBody}
          briefBusy={briefBusy}
          surveyKey={`${proposal?.id ?? ''}:${proposal?.status ?? ''}`}
          pollMs={pollMs}
          retired={retired}
          hasSurvey={
            proposal !== null && proposal?.status !== 'failed' && proposal?.status !== 'running'
          }
        />
      </div>

      {proposal?.status === 'ready' && (
        <div className="card survey-decision">
          <p className="muted">
            Accepting completes the survey stage. Answers are saved to the brief separately — save
            them first so the next stages can use them.
          </p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => void decide('rejected')}>
              Reject
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void decide('accepted')}
            >
              <Icon name="check" /> Accept survey
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
