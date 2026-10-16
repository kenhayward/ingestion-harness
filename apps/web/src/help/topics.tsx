import type { ReactNode } from 'react';
import { SectionsHelp } from './SectionsHelp.js';

/** A help topic: the dialog's title and its content (HelpButton in `ui/Help.tsx`). */
export interface HelpTopic {
  title: string;
  body: ReactNode;
}

/** Every help topic, by id. Add a topic here, then `<HelpButton topic="id" />` where needed. */
export const HELP_TOPICS = {
  sections: { title: 'How sections work', body: <SectionsHelp /> },
} satisfies Record<string, HelpTopic>;

export type HelpTopicId = keyof typeof HELP_TOPICS;
