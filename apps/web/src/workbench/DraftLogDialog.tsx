import type { DraftLog, DraftLogEntry } from '@ih/shared';
import { useEffect, useState } from 'react';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { HelpButton } from '../ui/Help.js';
import { Icon } from '../ui/Icon.js';
import { draftAttempts, type AttemptStatus, type LogAttempt } from './draft-log.js';

const STATUS_WORD: Record<AttemptStatus, string> = {
  accepted: 'accepted',
  refused: 'refused',
  stopped: 'stopped',
  unanswered: 'no answer',
};
const STATUS_MARK: Record<AttemptStatus, string> = {
  accepted: '✓',
  refused: '✗',
  stopped: '!',
  unanswered: '…',
};

function tokens(n: number | null): string {
  return n === null ? '' : ` · ${n.toLocaleString('en-GB')} tokens`;
}

function Entry({ entry }: { entry: DraftLogEntry }) {
  switch (entry.kind) {
    case 'prompt':
      return (
        <details className="model-log-entry">
          <summary>
            Prompt sent ({entry.text.length.toLocaleString('en-GB')} characters
            {entry.images ? `, ${entry.images} page images` : ''})
          </summary>
          <pre>{entry.text}</pre>
        </details>
      );
    case 'reply':
      return entry.text ? (
        <details className="model-log-entry">
          <summary>Reply{tokens(entry.outputTokens)}</summary>
          <pre>{entry.text}</pre>
        </details>
      ) : (
        <p className="model-log-entry muted">Reply{tokens(entry.outputTokens)}</p>
      );
    case 'toolCall':
      return (
        <details className="model-log-entry model-log-tool">
          <summary>
            {entry.name === 'submit' ? (
              <strong>Answer submitted</strong>
            ) : (
              <>
                <code>{entry.name}</code> <span>{entry.summary}</span>
              </>
            )}
          </summary>
          <pre>{JSON.stringify(entry.input, null, 2)}</pre>
        </details>
      );
    case 'toolResult':
      return (
        <details className={`model-log-entry model-log-result${entry.isError ? ' is-error' : ''}`}>
          <summary>{entry.isError ? 'Tool error' : 'Tool result'}</summary>
          <pre>{entry.text}</pre>
        </details>
      );
    case 'rejected':
      return (
        <div className="model-log-entry model-log-rejected">
          <strong>Answer rejected</strong>
          <ul>
            {entry.errors.map((e, i) => (
              <li key={`${i}:${e}`}>{e}</li>
            ))}
          </ul>
        </div>
      );
    case 'note':
      return <p className="model-log-entry muted">{entry.text}</p>;
    case 'error':
      return (
        <p className="model-log-entry model-log-error">
          <Icon name="warning" size={14} /> <strong>Stopped:</strong> <span>{entry.message}</span>
        </p>
      );
  }
}

function summaryOf(log: DraftLog): string {
  const entries = log.rounds.flatMap((r) => r.entries);
  const replies = entries.filter((e) => e.kind === 'reply').length;
  const calls = entries.filter((e) => e.kind === 'toolCall' && e.name !== 'submit').length;
  const parts = [`${replies} repl${replies === 1 ? 'y' : 'ies'}`];
  if (log.tools) parts.push(`${calls} tool call${calls === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** One attempt: how it ended, then what the model was sent, did and answered. */
function AttemptDetail({ name, attempt }: { name: string; attempt: LogAttempt }) {
  const heading = `${name}, attempt ${attempt.n}`;
  return (
    <section className="step-log-attempt" aria-label={heading}>
      <h3>
        {heading}
        {attempt.outputTokens !== null && (
          <span className="muted">
            {' '}
            · {attempt.outputTokens.toLocaleString('en-GB')} output tokens
          </span>
        )}
      </h3>
      {attempt.status === 'refused' && (
        <div className="step-log-errors">
          <h4>Errors that sent it back</h4>
          <ul>
            {attempt.errors.map((e, i) => (
              <li key={`${i}:${e}`}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {attempt.status === 'accepted' && (
        <p className="step-log-accepted">Accepted: this answer passed the checks.</p>
      )}
      {attempt.status === 'unanswered' && (
        <p className="muted">No answer was recorded for this attempt.</p>
      )}
      <ol className="model-log">
        {attempt.entries
          .filter((e) => e.kind !== 'rejected')
          .map((entry, j) => (
            <li key={j}>
              <Entry entry={entry} />
            </li>
          ))}
      </ol>
    </section>
  );
}

/** Rounds and attempts on the left, the attempt picked on the right (as a step's model log). */
function LogPanes({ log }: { log: DraftLog }) {
  const rounds = draftAttempts(log);
  const [picked, setPicked] = useState<[number, number]>([0, 0]);
  if (rounds.length === 0) return <p className="muted">The log has no entries yet.</p>;
  const round = rounds[picked[0]];
  const shown = round?.attempts[picked[1]];
  return (
    <div className="step-log">
      <nav className="step-log-nav" aria-label="Rounds and attempts">
        <ul>
          {rounds.map((r, ri) => (
            <li key={`${ri}:${r.label}`}>
              <span className="step-log-file">{r.name}</span>
              <ul className="step-log-attempts">
                {r.attempts.map((a, ai) => (
                  <li key={a.n}>
                    <button
                      type="button"
                      aria-pressed={picked[0] === ri && picked[1] === ai}
                      aria-label={`${r.name}, attempt ${a.n} ${STATUS_WORD[a.status]}`}
                      data-tone={a.status === 'accepted' ? 'ok' : 'warn'}
                      onClick={() => setPicked([ri, ai])}
                    >
                      Attempt {a.n} <span aria-hidden="true">{STATUS_MARK[a.status]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </nav>
      <div className="step-log-detail">
        {round && shown && <AttemptDetail name={round.name} attempt={shown} />}
      </div>
    </div>
  );
}

/** A drafting proposal's model log: its rounds and attempts, one attempt at a time. */
export function DraftLogDialog({
  api,
  projectId,
  proposalId,
  onClose,
}: {
  api: Api;
  projectId: string;
  proposalId: string;
  onClose: () => void;
}) {
  const [log, setLog] = useState<DraftLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.getProposalLog(projectId, proposalId).then(
      (l) => live && setLog(l),
      (err: unknown) => live && setError((err as Error).message),
    );
    return () => {
      live = false;
    };
  }, [api, projectId, proposalId]);

  return (
    <Dialog
      title="Model log"
      onClose={onClose}
      closeLabel="Close"
      className="model-log-dialog step-log-dialog"
    >
      <div className="model-log-head">
        <p className="muted">
          {log ? summaryOf(log) : error ? 'No log to show.' : 'Loading the model log…'}
        </p>
        <HelpButton topic="draftModelLog" />
      </div>
      {error && <p role="alert">{error}</p>}
      {log?.legacy && (
        <p className="muted">
          This run is from before the full model log: prompts, replies and rejections only.
        </p>
      )}
      {log && <LogPanes log={log} />}
    </Dialog>
  );
}

/** The Model log button of a proposal (ready, decided or failed), opening its dialog. */
export function ModelLogButton({
  api,
  projectId,
  proposalId,
}: {
  api: Api;
  projectId: string;
  proposalId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="model-log-button" onClick={() => setOpen(true)}>
        <Icon name="file" size={14} />
        Model log
      </button>
      {open && (
        <DraftLogDialog
          api={api}
          projectId={projectId}
          proposalId={proposalId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
