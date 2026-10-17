import type { DraftLog, DraftLogEntry } from '@ih/shared';
import { useEffect, useState } from 'react';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { HelpButton } from '../ui/Help.js';
import { Icon } from '../ui/Icon.js';

/** What a proposal round is called: the first is the proposal, then the sections anchor round. */
function roundName(label: string, index: number): string {
  if (index === 0) return 'Proposal';
  return label.endsWith('-anchors') ? 'Anchor round' : `Round ${index + 1}`;
}

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

/** A drafting proposal's model log: what the model was sent, said and did, round by round. */
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
    <Dialog title="Model log" onClose={onClose} closeLabel="Close" className="model-log-dialog">
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
      {log?.rounds.map((round, i) => (
        <section
          key={`${i}:${round.label}`}
          className="model-log-round"
          aria-label={roundName(round.label, i)}
        >
          <h3>{roundName(round.label, i)}</h3>
          <ol className="model-log">
            {round.entries.map((entry, j) => (
              <li key={j}>
                <Entry entry={entry} />
              </li>
            ))}
          </ol>
        </section>
      ))}
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
