import { useCallback, useEffect, useState } from 'react';
import type { JobSummary, StatusGroup } from '@ih/shared';
import type { Api } from '../api/client.js';

/**
 * A jobs poll: the newest jobs (Home, the Jobs page), or with `group` every job of that status
 * group however old (`attention`: the nav badge and the review queue, so none is missed behind
 * the newest). pollMs <= 0 = load once (tests). `mine`: only the signed-in token's jobs (the
 * Jobs page's My jobs); `enabled: false` stops loading and polling.
 */
export function useJobs(
  api: Api,
  pollMs: number,
  {
    mine = false,
    enabled = true,
    group,
    limit,
  }: { mine?: boolean; enabled?: boolean; group?: StatusGroup; limit?: number } = {},
) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** A load has finished (until then an empty list means "not known yet", not "none"). */
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setJobs(
        await (group
          ? api.listJobs({ group, ...(limit ? { limit } : {}) })
          : mine
            ? api.listJobs({ mine: true })
            : api.listJobs()),
      );
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [api, mine, group, limit]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    if (pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs, enabled]);

  return { jobs, error, refresh, loaded };
}
