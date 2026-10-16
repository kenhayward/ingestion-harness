import type { HelpTopicId } from './topics.js';

/** One entry of the Help dialog's menu: a topic and the label it has there. */
export interface HelpEntry {
  topic: HelpTopicId;
  label: string;
  /** The screen's parts (tabs, kinds), listed under it. */
  children?: HelpEntry[];
}

/**
 * The Help dialog's menu (HelpCenter): the introduction, then the major screens in the order of
 * the nav, each with its parts. Every topic in HELP_TOPICS appears exactly once (a test holds
 * this), so a new topic must be placed here too.
 */
export const HELP_INDEX: HelpEntry[] = [
  { topic: 'introduction', label: 'Introduction' },
  { topic: 'home', label: 'Home' },
  {
    topic: 'jobs',
    label: 'Jobs',
    children: [{ topic: 'review', label: 'Reviewing a document' }],
  },
  {
    topic: 'results',
    label: 'Results',
    children: [{ topic: 'result', label: 'A published result' }],
  },
  {
    topic: 'templates',
    label: 'Document types',
    children: [
      { topic: 'general', label: 'General' },
      { topic: 'sections', label: 'Sections' },
      { topic: 'outputs', label: 'Outputs' },
      { topic: 'pipeline', label: 'Pipeline' },
      { topic: 'mapping', label: 'Mapping' },
      { topic: 'yaml', label: 'YAML' },
      { topic: 'quality', label: 'Quality' },
      { topic: 'versions', label: 'Versions' },
    ],
  },
  {
    topic: 'workbench',
    label: 'Workbench',
    children: [
      { topic: 'wbOverview', label: 'Overview' },
      { topic: 'wbSamples', label: 'Samples' },
      { topic: 'wbBrief', label: 'Brief' },
      { topic: 'wbSurvey', label: 'Survey' },
      { topic: 'wbOutputs', label: 'Outputs stage' },
      { topic: 'wbSections', label: 'Sections stage' },
      { topic: 'wbSteps', label: 'Steps stage' },
      { topic: 'wbMapping', label: 'Mapping stage' },
      { topic: 'wbReferences', label: 'References' },
      { topic: 'wbEvaluate', label: 'Evaluate' },
      { topic: 'wbRevise', label: 'Revise' },
      { topic: 'wbRecipe', label: 'Recipe' },
      { topic: 'wbRuns', label: 'Test runs' },
    ],
  },
  {
    topic: 'ontologies',
    label: 'Ontologies',
    children: [
      { topic: 'ontology', label: 'An ontology' },
      { topic: 'ontologyClasses', label: 'Classes' },
      { topic: 'ontologyProperties', label: 'Properties' },
      { topic: 'ontologyConcepts', label: 'Concepts and schemes' },
      { topic: 'ontologyShapes', label: 'Shapes' },
    ],
  },
  { topic: 'github-sync', label: 'GitHub sync' },
];

/** Every entry of the menu, parents before their children. */
export function helpEntries(index: readonly HelpEntry[] = HELP_INDEX): HelpEntry[] {
  return index.flatMap((e) => [e, ...helpEntries(e.children ?? [])]);
}

/** A topic id from an address (`#/help/<topic>`), or null when there is no such topic. */
export function helpTopicOf(value: string | undefined): HelpTopicId | null {
  return helpEntries().find((e) => e.topic === value)?.topic ?? null;
}
