import { useId, type ReactNode } from 'react';
import type { RemoteListing, RemoteVersion } from '@ih/shared';
import { relativeTime } from '../../jobs/derive.js';
import { shortCommit } from './SyncChip.js';

/** Stable id of a version in a listing. */
export const remoteKey = (v: Pick<RemoteVersion, 'instance' | 'typeId' | 'version'>) =>
  `${v.instance}/${v.typeId}/v${v.version}`;

interface Group<T> {
  instance: string;
  types: { typeId: string; versions: T[] }[];
}

/** Deployment, then type, then versions newest first. */
export function groupListing<T extends RemoteVersion>(versions: T[]): Group<T>[] {
  const groups = new Map<string, Map<string, T[]>>();
  for (const v of versions) {
    const types = groups.get(v.instance) ?? new Map<string, T[]>();
    types.set(v.typeId, [...(types.get(v.typeId) ?? []), v]);
    groups.set(v.instance, types);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([instance, types]) => ({
      instance,
      types: [...types]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([typeId, vs]) => ({
          typeId,
          versions: [...vs].sort((a, b) => b.version - a.version),
        })),
    }));
}

/**
 * The recipe versions found in a repository folder, grouped by deployment and type. With `onPick`
 * each version is a radio button; `actions` adds buttons to a row instead. Files that could not be
 * read are listed under *Not readable* with the reason.
 */
export function RepoBrowser<T extends RemoteVersion = RemoteVersion>({
  listing,
  picked = null,
  onPick,
  actions,
  now = Date.now(),
}: {
  listing: { versions: T[]; skipped: RemoteListing['skipped'] };
  picked?: RemoteVersion | null;
  onPick?: (v: T) => void;
  actions?: (v: T) => ReactNode;
  now?: number;
}) {
  const name = useId();
  const groups = groupListing(listing.versions);
  return (
    <div className="repo-browser">
      {groups.length === 0 && <p className="muted">No recipes found.</p>}
      {groups.map((g) => (
        <section key={g.instance} aria-label={`Deployment ${g.instance}`}>
          <h4>{g.instance}</h4>
          {g.types.map((t) => (
            <div key={t.typeId}>
              <h5 className="mono">{t.typeId}</h5>
              <ul className="repo-versions" aria-label={`${g.instance} ${t.typeId} versions`}>
                {t.versions.map((v) => {
                  const text = [
                    `v${v.version}`,
                    v.label,
                    v.publishedBy ? `published by ${v.publishedBy}` : null,
                    v.publishedAt ? relativeTime(v.publishedAt, now) : null,
                    v.commit ? shortCommit(v.commit) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <li key={remoteKey(v)}>
                      {onPick ? (
                        <label>
                          <input
                            type="radio"
                            name={name}
                            checked={picked !== null && remoteKey(picked) === remoteKey(v)}
                            onChange={() => onPick(v)}
                          />{' '}
                          {text}
                        </label>
                      ) : (
                        <span>{text}</span>
                      )}
                      {actions?.(v)}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      ))}
      {listing.skipped.length > 0 && (
        <section aria-label="Not readable">
          <h4>Not readable</h4>
          <ul>
            {listing.skipped.map((s) => (
              <li key={s.path}>
                <span className="mono">{s.path}</span>: {s.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
