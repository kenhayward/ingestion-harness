import type { DraftLog, DraftLogEntry } from '@ih/shared';

/** How one try at answering ended. */
export type AttemptStatus = 'accepted' | 'refused' | 'stopped' | 'unanswered';

export interface LogAttempt {
  n: number;
  status: AttemptStatus;
  /** Why the answer was sent back (`refused`). */
  errors: string[];
  /** What stopped the run (`stopped`). */
  error: string | null;
  /** The attempt's entries in order: prompt, replies, tool calls and results, the rejection. */
  entries: DraftLogEntry[];
  /** Its replies' output tokens added up (null: none reported). */
  outputTokens: number | null;
}

export interface LogRound {
  label: string;
  /** Proposal, Anchor round, Round 3… */
  name: string;
  attempts: LogAttempt[];
}

/** What a proposal round is called: the first is the proposal, then the sections anchor round. */
export function roundName(label: string, index: number): string {
  if (index === 0) return 'Proposal';
  return label.endsWith('-anchors') ? 'Anchor round' : `Round ${index + 1}`;
}

function attemptOf(n: number, entries: DraftLogEntry[]): LogAttempt {
  const rejected = entries.find((e) => e.kind === 'rejected');
  const stop = entries.find((e) => e.kind === 'error');
  const answered = entries.some(
    (e) => e.kind === 'reply' || (e.kind === 'toolCall' && e.name === 'submit'),
  );
  const status: AttemptStatus = rejected
    ? 'refused'
    : stop
      ? 'stopped'
      : answered
        ? 'accepted'
        : 'unanswered';
  const tokens = entries.flatMap((e) =>
    e.kind === 'reply' && e.outputTokens !== null ? [e.outputTokens] : [],
  );
  return {
    n,
    status,
    errors: rejected?.kind === 'rejected' ? rejected.errors : [],
    error: stop?.kind === 'error' ? stop.message : null,
    entries,
    outputTokens: tokens.length > 0 ? tokens.reduce((a, b) => a + b, 0) : null,
  };
}

/**
 * A drafting model log as rounds of attempts, for the model log dialog: a round's entries are
 * split after each rejected answer, so an attempt is what the model was sent or asked again
 * (the retry note opens the next one), what it did with tools and what it answered, and how
 * that ended. Rounds with no entries are left out.
 */
export function draftAttempts(log: DraftLog): LogRound[] {
  return log.rounds.flatMap((round, i) => {
    if (round.entries.length === 0) return [];
    const parts: DraftLogEntry[][] = [[]];
    for (const entry of round.entries) {
      parts[parts.length - 1]!.push(entry);
      if (entry.kind === 'rejected') parts.push([]);
    }
    const attempts = parts
      .filter((p) => p.length > 0)
      .map((entries, j) => attemptOf(j + 1, entries));
    return [{ label: round.label, name: roundName(round.label, i), attempts }];
  });
}
