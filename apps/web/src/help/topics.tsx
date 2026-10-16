import type { ReactNode } from 'react';
import { GeneralHelp } from './GeneralHelp.js';
import { GitHubSyncHelp } from './GitHubSyncHelp.js';
import { MappingHelp } from './MappingHelp.js';
import { OutputsHelp } from './OutputsHelp.js';
import { PipelineHelp } from './PipelineHelp.js';
import { PublishedOutputsHelp } from './PublishedOutputsHelp.js';
import { QualityHelp } from './QualityHelp.js';
import { SectionsHelp } from './SectionsHelp.js';
import { VersionsHelp } from './VersionsHelp.js';
import { YamlHelp } from './YamlHelp.js';

/** A help topic: the dialog's title and its content (HelpButton in `ui/Help.tsx`). */
export interface HelpTopic {
  title: string;
  body: ReactNode;
}

/** Every help topic, by id. Add a topic here, then `<HelpButton topic="id" />` where needed. */
export const HELP_TOPICS = {
  'github-sync': { title: 'How GitHub sync works', body: <GitHubSyncHelp /> },
  'published-outputs': { title: 'How publishing targets work', body: <PublishedOutputsHelp /> },
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
