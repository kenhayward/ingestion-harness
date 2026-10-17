import { z } from 'zod';

/**
 * The build's version (ADR 0014): the calendar tag `YYYY.MM.DD.N` CI put on the commit, else
 * `<nearest tag>+<hash>` or `dev+<hash>`, with `+dirty`/`.dirty` for uncommitted changes. Worked
 * out by `deploy/scripts/version.mjs` and baked into the images; never stored in a file.
 */
export const VersionInfoSchema = z.object({
  version: z.string(),
  /** The calendar tag before this build's (null for the first tag or a dev build). */
  previous: z.string().nullable(),
  /** The short commit hash. */
  commit: z.string(),
});
export type VersionInfo = z.infer<typeof VersionInfoSchema>;

export const DEV_VERSION: VersionInfo = { version: 'dev', previous: null, commit: 'unknown' };

export const REPO_URL = 'https://github.com/kenhayward/ingestion-harness';

const CALENDAR_TAG = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;

/** GitHub's view of what this build added: the comparison with the previous tag, else null. */
export function versionLink(info: VersionInfo, repo = REPO_URL): string | null {
  const plus = info.version.indexOf('+');
  const base = plus < 0 ? info.version : info.version.slice(0, plus);
  const suffix = plus < 0 ? null : info.version.slice(plus + 1);
  if (!CALENDAR_TAG.test(base)) return null;
  if (suffix === null || suffix === 'dirty') {
    return info.previous ? `${repo}/compare/${info.previous}...${base}` : `${repo}/tree/${base}`;
  }
  return info.previous ? `${repo}/compare/${info.previous}...${info.commit}` : null;
}
