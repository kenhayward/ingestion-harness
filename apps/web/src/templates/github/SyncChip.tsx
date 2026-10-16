import type { VersionSync } from '@ih/shared';

/** The first seven characters of a commit sha, as GitHub shows it. */
export const shortCommit = (commit: string) => commit.slice(0, 7);

const CHIP: Record<Exclude<VersionSync['state'], 'pr'>, { text: string; tone: string }> = {
  on: { text: 'On GitHub', tone: 'tone-ok' },
  label: { text: 'Label changed since push', tone: 'tone-warn' },
  absent: { text: 'Not on GitHub', tone: 'tone-neutral' },
  differs: { text: 'Different on GitHub', tone: 'tone-warn' },
};

/** Where a published version stands against GitHub (the Versions list). */
export function SyncChip({ sync }: { sync: VersionSync }) {
  if (sync.state === 'pr') {
    const text = sync.prNumber === null ? 'Pull request open' : `PR #${sync.prNumber} open`;
    return sync.prUrl ? (
      <a className="kind-tag tone-info" href={sync.prUrl} target="_blank" rel="noreferrer">
        {text}
      </a>
    ) : (
      <span className="kind-tag tone-info">{text}</span>
    );
  }
  const { text, tone } = CHIP[sync.state];
  return (
    <>
      <span className={`kind-tag ${tone}`}>{text}</span>
      {sync.state === 'on' && sync.commit && sync.commitUrl && (
        <a href={sync.commitUrl} target="_blank" rel="noreferrer">
          {shortCommit(sync.commit)}
        </a>
      )}
    </>
  );
}
