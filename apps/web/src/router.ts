import { useEffect, useState } from 'react';

export type Route =
  | { name: 'jobs' }
  | { name: 'review'; jobId: string }
  | { name: 'templates' }
  | { name: 'template'; templateId: string; version: number };

export function parseHash(hash: string): Route {
  const review = /^#\/review\/([^/]+)$/.exec(hash);
  if (review) return { name: 'review', jobId: decodeURIComponent(review[1]!) };
  const template = /^#\/templates\/([^/]+)\/(\d+)$/.exec(hash);
  if (template) {
    return {
      name: 'template',
      templateId: decodeURIComponent(template[1]!),
      version: Number(template[2]),
    };
  }
  if (hash === '#/templates') return { name: 'templates' };
  return { name: 'jobs' };
}

/** Minimal hash routing: #/ (jobs), #/review/<jobId>, #/templates, #/templates/<id>/<version>. */
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
