import { useCallback, useEffect, useState } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Api } from '../api/client.js';

/**
 * The jobs poll, shared by the nav badge and the Jobs page. pollMs <= 0 = load once (tests).
 * `mine`: only the signed-in token's jobs (the Jobs page's My jobs); `enabled: false` stops
 * loading and polling.
 */
export function useJobs(
  api: Api,
  pollMs: number,
  { mine = false, enabled = true }: { mine?: boolean; enabled?: boolean } = {},
) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** A load has finished (until then an empty list means "not known yet", not "none"). */
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setJobs(await (mine ? api.listJobs({ mine: true }) : api.listJobs()));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [api, mine]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    if (pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs, enabled]);

  return { jobs, error, refresh, loaded };
}
