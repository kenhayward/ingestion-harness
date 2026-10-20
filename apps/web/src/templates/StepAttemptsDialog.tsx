import type { RetriedRun, StepAttempt, StepAttempts } from '@ih/shared';
import { useEffect, useState } from 'react';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';

/** A model call's name in the list: a step's own call has none; parts say what they read. */
export function callName(stepId: string, label: string): string | null {
  if (label === stepId) return null;
  const part = label.slice(stepId.length + 1);
  const named = part.split('.').map((p) => {
    const [kind, n] = p.split('-');
    if (kind === 'chunk') return `pages, part ${n}`;
    if (kind === 'occ') return `occurrence ${n}`;
    if (kind === 'ask') return `question ${n}`;
    return p;
  });
  const text = named.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

const count = (n: number | null, what: string) =>
  n === null ? null : `${n.toLocaleString('en-GB')} ${what}`;

function AttemptView({ attempt }: { attempt: StepAttempt }) {
  const tokens = [
    count(attempt.inputTokens, 'input tokens'),
    count(attempt.outputTokens, 'output tokens'),
  ]
    .filter(Boolean)
    .join(' · ');
  const heading = `Attempt ${attempt.n}`;
  return (
    <section className="step-log-attempt" aria-label={heading}>
      <h3>
        {heading}
        {tokens && <span className="muted"> · {tokens}</span>}
      </h3>
      {attempt.errors.length > 0 ? (
        <div className="step-log-errors">
          <h4>Errors that sent it back</h4>
          <ul>
            {attempt.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="step-log-accepted">Accepted: this reply passed the checks.</p>
      )}
      <details className="model-log-entry">
        <summary>Prompt sent ({attempt.prompt.length.toLocaleString('en-GB')} characters)</summary>
        <pre>{attempt.prompt}</pre>
      </details>
      <details className="model-log-entry" open>
        <summary>Reply</summary>
        <pre>{attempt.response}</pre>
      </details>
    </section>
  );
}

/**
 * A step's model log (the Pipeline's "Needs a retry" warning): the step's recent runs that
 * needed more than one attempt on the left, each opening to its attempts; the attempt picked on
 * the right, with the errors that sent it back, the prompt and the reply.
 */
export function StepAttemptsDialog({
  api,
  templateId,
  jobId,
  stepId,
  onClose,
}: {
  api: Api;
  stepId: string;
  onClose: () => void;
} & (
  | {
      /** The step's recent retried runs, from its retry warning. */ templateId: string;
      jobId?: undefined;
    }
  | { /** One job's run of the step (the Review page). */ jobId: string; templateId?: undefined }
)) {
  const [runs, setRuns] = useState<RetriedRun[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(jobId ?? null);
  const [log, setLog] = useState<StepAttempts | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  /** [call index, attempt index] within the open run's log. */
  const [picked, setPicked] = useState<[number, number]>([0, 0]);

  useEffect(() => {
    if (templateId === undefined) return;
    let live = true;
    api.listRetriedStepRuns(templateId, stepId).then(
      (r) => {
        if (!live) return;
        setRuns(r.runs);
        setOpenRun(r.runs[0]?.jobId ?? null);
      },
      (e: Error) => live && setRunsError(e.message),
    );
    return () => {
      live = false;
    };
  }, [api, templateId, stepId]);

  useEffect(() => {
    if (!openRun) return;
    let live = true;
    setLog(null);
    setLogError(null);
    setPicked([0, 0]);
    api.getStepAttempts(openRun, stepId).then(
      (l) => live && setLog(l),
      (e: Error) => live && setLogError(e.message),
    );
    return () => {
      live = false;
    };
  }, [api, openRun, stepId]);

  const shown = log?.calls[picked[0]]?.attempts[picked[1]];
  /** The open run's calls and attempts, each attempt a button showing it on the right. */
  const attemptList = (l: StepAttempts) => (
    <ul className="step-log-attempts">
      {l.calls.map((call, ci) => (
        <li key={call.label}>
          {callName(stepId, call.label) && (
            <span className="step-log-call">{callName(stepId, call.label)}</span>
          )}
          <ul>
            {call.attempts.map((a, ai) => {
              const ok = a.errors.length === 0;
              return (
                <li key={a.n}>
                  <button
                    type="button"
                    aria-pressed={picked[0] === ci && picked[1] === ai}
                    aria-label={`Attempt ${a.n} ${ok ? 'accepted' : 'refused'}`}
                    data-tone={ok ? 'ok' : 'warn'}
                    onClick={() => setPicked([ci, ai])}
                  >
                    Attempt {a.n} <span aria-hidden="true">{ok ? '✓' : '✗'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
  return (
    <Dialog
      title={`Model log: ${stepId}`}
      onClose={onClose}
      closeLabel="Close"
      className="model-log-dialog step-log-dialog"
    >
      <p className="muted">
        {jobId
          ? "This job's attempts of the step. Pick an attempt to see what the model was sent, what it answered, and why an answer was sent back."
          : 'The recent runs of this step whose first answer failed its checks. Pick an attempt to see what the model was sent, what it answered, and why the answer was sent back.'}
      </p>
      {jobId && (
        <div className="step-log">
          <nav className="step-log-nav" aria-label="Attempts">
            {log && attemptList(log)}
          </nav>
          <div className="step-log-detail">
            {logError && <p role="alert">{logError}</p>}
            {!log && !logError && <p className="muted">Loading the attempts…</p>}
            {shown && <AttemptView attempt={shown} />}
          </div>
        </div>
      )}
      {runsError && <p role="alert">{runsError}</p>}
      {!jobId && runs === null && !runsError && <p className="muted">Loading the runs…</p>}
      {runs?.length === 0 && <p className="muted">No run of this step has needed a retry yet.</p>}
      {runs && runs.length > 0 && (
        <div className="step-log">
          <nav className="step-log-nav" aria-label="Runs and attempts">
            <ul>
              {runs.map((r) => (
                <li key={r.jobId}>
                  <button
                    type="button"
                    className="step-log-run"
                    aria-expanded={openRun === r.jobId}
                    onClick={() => setOpenRun(r.jobId)}
                  >
                    <span className="step-log-file">{r.fileName}</span>
                    <small className="muted">
                      {when(r.startedAt)} · v{r.version} · {r.attempts} attempts
                      {r.trigger === 'rerun' ? ' · re-run' : ''}
                      {r.status === 'failed' ? ' · failed' : ''}
                    </small>
                  </button>
                  {openRun === r.jobId && log && attemptList(log)}
                </li>
              ))}
            </ul>
          </nav>
          <div className="step-log-detail">
            {logError && <p role="alert">{logError}</p>}
            {!log && !logError && <p className="muted">Loading the attempts…</p>}
            {shown && <AttemptView attempt={shown} />}
          </div>
        </div>
      )}
    </Dialog>
  );
}
