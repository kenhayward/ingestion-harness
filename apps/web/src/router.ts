import { useEffect, useState } from 'react';

export type Route = { name: 'jobs' } | { name: 'review'; jobId: string };

export function parseHash(hash: string): Route {
  const review = /^#\/review\/([^/]+)$/.exec(hash);
  return review ? { name: 'review', jobId: decodeURIComponent(review[1]!) } : { name: 'jobs' };
}

/** Minimal hash routing: #/ (jobs) and #/review/<jobId>. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}
