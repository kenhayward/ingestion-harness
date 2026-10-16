import type { PushOutcome } from '@ih/shared';
import { shortCommit } from './SyncChip.js';

/** The status line after a publish: what happened to the automatic push, if one was tried. */
export function publishedMessage(version: number, outcome: PushOutcome | null | undefined): string {
  const base = `Published v${version}`;
  if (!outcome) return base;
  switch (outcome.kind) {
    case 'pushed':
      return `${base} · pushed to GitHub (commit ${shortCommit(outcome.commit)})`;
    case 'pr':
      return `${base} · pull request #${outcome.prNumber} opened`;
    case 'skipped':
      return `${base} · not pushed: ${outcome.reason}`;
    case 'failed':
      return `${base} · GitHub push failed: try again from Versions.`;
  }
}
