import { useEffect, useState } from 'react';
import type { Api } from '../api/client.js';

/** How often the nav badge asks how many watches have a problem. */
const WATCH_PROBLEMS_POLL_MS = 30_000;

/**
 * The number of running or draining watches with a problem (the Watched folders badge): read now
 * and every 30 s while `enabled` (admins only). A failed read keeps the last count.
 */
export function useWatchProblems(api: Api, enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = () =>
      api.getWatchProblems().then(
        (r) => live && setCount(r.count),
        () => undefined,
      );
    void read();
    const timer = setInterval(() => void read(), WATCH_PROBLEMS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, enabled]);
  return enabled ? count : 0;
}
