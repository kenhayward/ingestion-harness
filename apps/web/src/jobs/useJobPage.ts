import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobPage } from '@ih/shared';
import type { Api, JobPageParams } from '../api/client.js';

/**
 * One page of the Jobs list from the server (`GET /api/jobs/page`), asked again whenever
 * `params` change and every `pollMs` (<= 0: once). A response to older params is dropped, and
 * the last page stays shown while a new one loads or when a poll fails (`error`).
 */
export function useJobPage(api: Api, params: JobPageParams, pollMs: number) {
  const [page, setPage] = useState<JobPage | null>(null);
  /** The params `page` answers (a caller acting on a new page waits for it). */
  const [pageKey, setPageKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(params);
  const latest = useRef(key);
  latest.current = key;

  const refresh = useCallback(async () => {
    const asked = key;
    try {
      const next = await api.listJobPage(JSON.parse(asked) as JobPageParams);
      if (latest.current !== asked) return;
      setPage(next);
      setPageKey(asked);
      setError(null);
    } catch (err) {
      if (latest.current === asked) setError((err as Error).message);
    }
  }, [api, key]);

  useEffect(() => {
    void refresh();
    if (pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  return { page, current: pageKey === key, error, refresh };
}
