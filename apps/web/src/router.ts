import { useEffect, useState } from 'react';

export const PROJECT_TABS = [
  'overview',
  'samples',
  'brief',
  'survey',
  'outputs',
  'sections',
  'steps',
  'references',
  'evaluate',
  'revise',
  'template',
  'runs',
] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export type Route =
  | { name: 'home' }
  | { name: 'jobs' }
  | { name: 'review'; jobId: string }
  | { name: 'templates' }
  | { name: 'access' }
  | { name: 'models' }
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
    const tab = PROJECT_TABS.find((t) => t === project[2]) ?? 'overview';
    return { name: 'project', projectId: decodeURIComponent(project[1]!), tab };
  }
  if (hash === '#/jobs') return { name: 'jobs' };
  if (hash === '#/workbench') return { name: 'workbench' };
  if (hash === '#/results') return { name: 'results' };
  if (hash === '#/templates') return { name: 'templates' };
  if (hash === '#/access') return { name: 'access' };
  if (hash === '#/models') return { name: 'models' };
  return { name: 'home' };
}

/**
 * Minimal hash routing: #/ (home), #/jobs, #/review/<jobId>, #/results, #/results/<jobId>,
 * #/templates, #/templates/<id>/<version>, #/workbench, #/workbench/<id>[/<tab>] (Overview by default).
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
