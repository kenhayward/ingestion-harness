import { useEffect, useId, useRef, useState } from 'react';
import type { TemplateChange } from '@ih/shared';
import type { Api, VersionDiff } from '../api/client.js';
import { useModelChoices } from '../ui/ModelPicker.js';
import { modelsInChip } from '../workbench/changes.js';
import { changeAtText, changeTag } from './editor-derive.js';

const TAG_TONE: Record<TemplateChange['source'], string> = {
  hand: 'tone-neutral',
  proposal: 'tone-info',
  restore: 'tone-warn',
  started: 'tone-neutral',
  import: 'tone-neutral',
};

/**
 * *Changes since vN* (handoff §10, TP1): the open draft's change log, newest first, and the
 * full diff from the live version. Reloads when `refreshKey` changes (after each save).
 */
export function DraftChangesPanel({
  api,
  projectId,
  version,
  published,
  refreshKey,
}: {
  api: Api;
  projectId: string;
  version: number;
  published: number | null;
  refreshKey: number;
}) {
  const heading = useId();
  const choices = useModelChoices(api);
  const [changes, setChanges] = useState<TemplateChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  /** Numbers each load, so an older response never replaces a newer one. */
  const request = useRef(0);

  useEffect(() => {
    const n = ++request.current;
    api.listDraftChanges(projectId).then(
      (c) => {
        if (n !== request.current) return;
        setChanges(c);
        setError(null);
      },
      (err: Error) => {
        if (n === request.current) setError(err.message);
      },
    );
  }, [api, projectId, refreshKey]);

  /** Own sequence for the full diff, so a slower earlier response is dropped. */
  const diffRequest = useRef(0);
  useEffect(() => {
    const n = ++diffRequest.current;
    setDiff(null);
    setDiffError(null);
    if (!showDiff || published === null) return;
    api.diffVersions(projectId, published, version).then(
      (d) => {
        if (n === diffRequest.current) setDiff(d);
      },
      (err: Error) => {
        if (n === diffRequest.current) setDiffError(err.message);
      },
    );
  }, [api, projectId, published, version, showDiff, refreshKey]);

  const toggleDiff = () => setShowDiff((open) => !open);

  const title = published !== null ? `Changes since v${published}` : `Changes in draft v${version}`;
  return (
    <section className="card changes-panel" aria-labelledby={heading}>
      <div className="changes-panel-head">
        <h3 id={heading}>{title}</h3>
        {published !== null && (
          <button type="button" className="link" aria-expanded={showDiff} onClick={toggleDiff}>
            Full diff
          </button>
        )}
      </div>
      {error && <p role="alert">Could not load the changes: {error}</p>}
      {showDiff && diffError && <p role="alert">Could not load the full diff: {diffError}</p>}
      {showDiff && !diff && !diffError && <p className="muted">Loading…</p>}
      {showDiff && diff && (
        <ul className="full-diff" aria-label={`Full diff from v${diff.from}`}>
          {diff.changes.length === 0 && <li className="muted">No differences.</li>}
          {diff.changes.map((c, i) => (
            <li key={i}>
              <code>
                {c.kind} {c.path}
              </code>
            </li>
          ))}
        </ul>
      )}
      {changes !== null && changes.length === 0 && (
        <p className="muted">No changes recorded for this draft yet.</p>
      )}
      {changes !== null && changes.length > 0 && (
        <ul className="changes-list">
          {changes.map((c) => (
            <li key={c.id} aria-label={`${changeTag(c)}: ${c.summary}`}>
              <div className="change-meta">
                <span className={`kind-tag ${TAG_TONE[c.source]}`}>{changeTag(c)}</span>{' '}
                <time className="muted" dateTime={c.at}>
                  {changeAtText(c.at)}
                </time>
              </div>
              <p>{c.summary}</p>
              {c.diff.length > 0 && (
                <ul className="diff-chips">
                  {c.diff.map((d, i) => (
                    <li key={i}>
                      <code>{modelsInChip(d, choices)}</code>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
