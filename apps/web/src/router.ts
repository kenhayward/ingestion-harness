import { useEffect, useState } from 'react';
import { GITHUB_LINK_RESULTS, type GitHubLinkResult } from '@ih/shared';

export const PROJECT_TABS = [
  'overview',
  'samples',
  'brief',
  'survey',
  'outputs',
  'sections',
  'steps',
  'mapping',
  'references',
  'evaluate',
  'revise',
  'template',
  'runs',
] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export type Route =
  /** `focusUpload`: #/upload (the installed app's Upload documents shortcut, docs/design/pwa.md). */
  | { name: 'home'; focusUpload?: true }
  /** `jobId`: #/jobs/<id>, the Jobs page with that job open (a link someone shared). */
  | { name: 'jobs'; jobId?: string }
  | { name: 'review'; jobId: string }
  | { name: 'templates' }
  | { name: 'password' }
  /**
   * Home with the Profile dialog open: where GitHub sends the browser back to after a link
   * (`#/account/profile/github?github=<result>`), and `#/account/profile[/password]`.
   */
  | { name: 'profile'; tab: 'details' | 'password'; github?: GitHubLinkResult }
  | { name: 'ontologies' }
  | { name: 'ontology'; ontologyId: string }
  | { name: 'results' }
  | { name: 'result'; jobId: string }
  | { name: 'template'; templateId: string; version: number }
  | { name: 'workbench' }
  /** `view`: a tab within the project tab (`#/workbench/<id>/survey/ontologies`). */
  | { name: 'project'; projectId: string; tab: ProjectTab; view?: string };

/** The Jobs page with one job open: what *Copy link* shares. */
export const jobHash = (jobId: string) => `#/jobs/${encodeURIComponent(jobId)}`;

export function parseHash(hash: string): Route {
  const jobLink = /^#\/jobs\/([^/]+)$/.exec(hash);
  if (jobLink) return { name: 'jobs', jobId: decodeURIComponent(jobLink[1]!) };
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
  const ontology = /^#\/ontologies\/([^/]+)$/.exec(hash);
  if (ontology) return { name: 'ontology', ontologyId: decodeURIComponent(ontology[1]!) };
  const project = /^#\/workbench\/([^/]+)(?:\/([a-z]+)(?:\/([a-z]+))?)?$/.exec(hash);
  if (project) {
    const tab = PROJECT_TABS.find((t) => t === project[2]) ?? 'overview';
    const projectId = decodeURIComponent(project[1]!);
    return project[3]
      ? { name: 'project', projectId, tab, view: project[3] }
      : { name: 'project', projectId, tab };
  }
  if (hash === '#/jobs') return { name: 'jobs' };
  if (hash === '#/upload') return { name: 'home', focusUpload: true };
  if (hash === '#/workbench') return { name: 'workbench' };
  if (hash === '#/results') return { name: 'results' };
  if (hash === '#/templates') return { name: 'templates' };
  if (hash === '#/account/password') return { name: 'password' };
  const profile = /^#\/account\/profile(?:\/([a-z]+))?(?:\?github=([a-z]+))?$/.exec(hash);
  if (profile) {
    const tab = profile[1] === 'password' ? 'password' : 'details';
    const github = GITHUB_LINK_RESULTS.find((r) => r === profile[2]);
    return github ? { name: 'profile', tab, github } : { name: 'profile', tab };
  }
  if (hash === '#/ontologies') return { name: 'ontologies' };
  return { name: 'home' };
}

/**
 * Minimal hash routing: #/ (home), #/upload (home, upload strip focused), #/jobs, #/jobs/<jobId>,
 * #/review/<jobId>, #/results, #/results/<jobId>, #/templates, #/templates/<id>/<version>,
 * #/ontologies, #/ontologies/<id>, #/workbench, #/workbench/<id>[/<tab>[/<view>]] (Overview by
 * default; a view is a tab within that tab, e.g. survey/ontologies).
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
