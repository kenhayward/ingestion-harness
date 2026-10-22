import { OntologyMemoryHelp } from './OntologyMemoryHelp.js';
import type { ReactNode } from 'react';
import {
  AdministrationHelp,
  AdminLinkedDataHelp,
  AdminMaintenanceHelp,
  AdminModelsHelp,
  AdminUsersHelp,
} from './AdminHelp.js';
import { BackupHelp } from './BackupHelp.js';
import { GeneralHelp } from './GeneralHelp.js';
import { HomeHelp } from './HomeHelp.js';
import { IntroductionHelp } from './IntroductionHelp.js';
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
import { PublishedOutputsHelp } from './PublishedOutputsHelp.js';
import { ConnectionsHelp } from './ConnectionsHelp.js';
import { NamesHelp } from './NamesHelp.js';
import { QualityHelp } from './QualityHelp.js';
import { ResultHelp } from './ResultHelp.js';
import { ResultsHelp } from './ResultsHelp.js';
import { TemplatesHelp } from './TemplatesHelp.js';
import { SectionsHelp } from './SectionsHelp.js';
import { VersionsHelp } from './VersionsHelp.js';
import { WorkbenchHelp } from './WorkbenchHelp.js';
import {
  ReviewHelp,
  GraphViewsHelp,
  WbBriefHelp,
  WbEvaluateHelp,
  WbMappingHelp,
  WbOutputsHelp,
  WbOverviewHelp,
  WbRecipeHelp,
  WbReferencesHelp,
  WbReviseHelp,
  WbRunsHelp,
  DraftModelLogHelp,
  WbSamplesHelp,
  WbSectionsHelp,
  WbStepsHelp,
  WbSurveyHelp,
} from './WorkbenchTabsHelp.js';
import { YamlHelp } from './YamlHelp.js';

/** A help topic: the dialog's title and its content (HelpButton in `ui/Help.tsx`). */
export interface HelpTopic {
  title: string;
  body: ReactNode;
}

/** Every help topic, by id. Add a topic here, then `<HelpButton topic="id" />` where needed. */
export const HELP_TOPICS = {
  introduction: { title: 'Introduction', body: <IntroductionHelp /> },
  home: { title: 'Using the Home screen', body: <HomeHelp /> },
  jobs: { title: 'Using the Jobs page', body: <JobsHelp /> },
  results: { title: 'Using the Results page', body: <ResultsHelp /> },
  result: { title: 'Reading a published result', body: <ResultHelp /> },
  templates: { title: 'Using the Document types page', body: <TemplatesHelp /> },
  workbench: { title: 'Using the Workbench', body: <WorkbenchHelp /> },
  wbOverview: { title: 'The project overview', body: <WbOverviewHelp /> },
  wbSamples: { title: 'Samples', body: <WbSamplesHelp /> },
  wbBrief: { title: 'The brief', body: <WbBriefHelp /> },
  wbSurvey: { title: 'The survey', body: <WbSurveyHelp /> },
  wbOutputs: { title: 'Proposing outputs', body: <WbOutputsHelp /> },
  wbSections: { title: 'Finding section anchors', body: <WbSectionsHelp /> },
  wbSteps: { title: 'Proposing the pipeline', body: <WbStepsHelp /> },
  wbMapping: { title: 'Proposing a mapping', body: <WbMappingHelp /> },
  wbReferences: { title: 'References: the right answers', body: <WbReferencesHelp /> },
  wbEvaluate: { title: 'Evaluating the recipe', body: <WbEvaluateHelp /> },
  wbRevise: { title: 'Revising from feedback', body: <WbReviseHelp /> },
  wbRecipe: { title: 'The Recipe tab', body: <WbRecipeHelp /> },
  wbRuns: { title: 'Test runs', body: <WbRunsHelp /> },
  draftModelLog: { title: 'Reading a model log', body: <DraftModelLogHelp /> },
  review: { title: 'Reviewing a document', body: <ReviewHelp /> },
  graphViews: { title: 'Reading a graph', body: <GraphViewsHelp /> },
  ontologies: { title: 'The ontology library', body: <OntologiesHelp /> },
  ontology: { title: 'An ontology and its versions', body: <OntologyHelp /> },
  ontologyClasses: { title: 'Classes', body: <OntologyClassesHelp /> },
  ontologyProperties: { title: 'Properties', body: <OntologyPropertiesHelp /> },
  ontologyConcepts: { title: 'Concepts and schemes', body: <OntologyConceptsHelp /> },
  ontologyShapes: { title: 'Shapes', body: <OntologyShapesHelp /> },
  ontologyMemory: { title: 'Remembered mappings', body: <OntologyMemoryHelp /> },
  administration: { title: 'Administration', body: <AdministrationHelp /> },
  adminModels: { title: 'Models and model choices', body: <AdminModelsHelp /> },
  adminLinkedData: { title: 'Linked data settings', body: <AdminLinkedDataHelp /> },
  adminUsers: { title: 'Users and sign-in', body: <AdminUsersHelp /> },
  adminMaintenance: { title: 'Maintenance mode', body: <AdminMaintenanceHelp /> },
  'github-sync': { title: 'How GitHub sync works', body: <GitHubSyncHelp /> },
  'published-outputs': { title: 'How publishing targets work', body: <PublishedOutputsHelp /> },
  connections: { title: 'How connections work', body: <ConnectionsHelp /> },
  names: { title: 'How names work', body: <NamesHelp /> },
  backup: { title: 'Backing up and restoring CT Studio', body: <BackupHelp /> },
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
