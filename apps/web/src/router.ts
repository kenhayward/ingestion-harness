import { useEffect, useState } from 'react';

export const PROJECT_TABS = ['samples', 'brief', 'survey', 'sections', 'template', 'runs'] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export type Route =
  | { name: 'jobs' }
  | { name: 'review'; jobId: string }
  | { name: 'templates' }
  | { name: 'access' }
  | { name: 'results' }
  | { name: 'result'; jobId: string }
  | { name: 'template'; templateId: string; version: number }
  | { name: 'workbench' }
  | { name: 'project'; projectId: string; tab: ProjectTab };

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
  const result = /^#\/results\/([^/]+)$/.exec(hash);
  if (result) return { name: 'result', jobId: decodeURIComponent(result[1]!) };
  const project = /^#\/workbench\/([^/]+)(?:\/([a-z]+))?$/.exec(hash);
  if (project) {
    const tab = PROJECT_TABS.find((t) => t === project[2]) ?? 'samples';
    return { name: 'project', projectId: decodeURIComponent(project[1]!), tab };
  }
  if (hash === '#/workbench') return { name: 'workbench' };
  if (hash === '#/results') return { name: 'results' };
  if (hash === '#/templates') return { name: 'templates' };
  if (hash === '#/access') return { name: 'access' };
  return { name: 'jobs' };
}

/**
 * Minimal hash routing: #/ (jobs), #/review/<jobId>, #/results, #/results/<jobId>,
 * #/templates, #/templates/<id>/<version>, #/workbench, #/workbench/<id>[/<tab>].
 */
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
