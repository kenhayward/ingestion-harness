import type { ReactNode } from 'react';
import { GeneralHelp } from './GeneralHelp.js';
import { HomeHelp } from './HomeHelp.js';
import { JobsHelp } from './JobsHelp.js';
import { GitHubSyncHelp } from './GitHubSyncHelp.js';
import { MappingHelp } from './MappingHelp.js';
import { OntologiesHelp } from './OntologiesHelp.js';
import { OntologyHelp } from './OntologyHelp.js';
import {
  OntologyClassesHelp,
  OntologyConceptsHelp,
  OntologyPropertiesHelp,
  OntologyShapesHelp,
} from './OntologyTermsHelp.js';
import { OutputsHelp } from './OutputsHelp.js';
import { PipelineHelp } from './PipelineHelp.js';
import { QualityHelp } from './QualityHelp.js';
import { ResultHelp } from './ResultHelp.js';
import { ResultsHelp } from './ResultsHelp.js';
import { TemplatesHelp } from './TemplatesHelp.js';
import { SectionsHelp } from './SectionsHelp.js';
import { VersionsHelp } from './VersionsHelp.js';
import { WorkbenchHelp } from './WorkbenchHelp.js';
import { YamlHelp } from './YamlHelp.js';

/** A help topic: the dialog's title and its content (HelpButton in `ui/Help.tsx`). */
export interface HelpTopic {
  title: string;
  body: ReactNode;
}

/** Every help topic, by id. Add a topic here, then `<HelpButton topic="id" />` where needed. */
export const HELP_TOPICS = {
  home: { title: 'Using the Home screen', body: <HomeHelp /> },
  jobs: { title: 'Using the Jobs page', body: <JobsHelp /> },
  results: { title: 'Using the Results page', body: <ResultsHelp /> },
  result: { title: 'Reading a published result', body: <ResultHelp /> },
  templates: { title: 'Using the Document types page', body: <TemplatesHelp /> },
  workbench: { title: 'Using the Workbench', body: <WorkbenchHelp /> },
  ontologies: { title: 'The ontology library', body: <OntologiesHelp /> },
  ontology: { title: 'An ontology and its versions', body: <OntologyHelp /> },
  ontologyClasses: { title: 'Classes', body: <OntologyClassesHelp /> },
  ontologyProperties: { title: 'Properties', body: <OntologyPropertiesHelp /> },
  ontologyConcepts: { title: 'Concepts and schemes', body: <OntologyConceptsHelp /> },
  ontologyShapes: { title: 'Shapes', body: <OntologyShapesHelp /> },
  'github-sync': { title: 'How GitHub sync works', body: <GitHubSyncHelp /> },
  general: { title: 'General recipe settings', body: <GeneralHelp /> },
  sections: { title: 'How sections work', body: <SectionsHelp /> },
  outputs: { title: 'Outputs: fields and tables', body: <OutputsHelp /> },
  pipeline: { title: 'How the pipeline runs', body: <PipelineHelp /> },
  mapping: { title: 'Mapping outputs to an ontology', body: <MappingHelp /> },
  yaml: { title: 'Editing the recipe as YAML', body: <YamlHelp /> },
  quality: { title: 'Reading the Quality tab', body: <QualityHelp /> },
  versions: { title: 'Versions, labels and drafts', body: <VersionsHelp /> },
} satisfies Record<string, HelpTopic>;

export type HelpTopicId = keyof typeof HELP_TOPICS;
