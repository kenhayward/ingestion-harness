import { z } from 'zod';

/**
 * A recipe version's label and note (issue #144, migration 0044): what a person says the version
 * is for. Metadata only: never part of the definition, so it changes nothing that runs and can be
 * set on published versions too.
 */
export const VERSION_LABEL_MAX = 80;
export const VERSION_NOTE_MAX = 2000;

const Label = z
  .string()
  .trim()
  .min(1, 'a label cannot be blank; send null to clear it')
  .max(VERSION_LABEL_MAX);
const Note = z
  .string()
  .trim()
  .min(1, 'a note cannot be blank; send null to clear it')
  .max(VERSION_NOTE_MAX);

/** What a version's label and note are set to: a field left out keeps its value, null clears it. */
export const VersionLabelBodySchema = z
  .object({
    label: Label.nullable()
      .optional()
      .describe(`A short name, up to ${VERSION_LABEL_MAX} characters; null clears it.`),
    note: Note.nullable()
      .optional()
      .describe(`A longer comment, up to ${VERSION_NOTE_MAX} characters; null clears it.`),
  })
  .strict()
  .refine((b) => b.label !== undefined || b.note !== undefined, 'send a label or a note');
export type VersionLabelBody = z.infer<typeof VersionLabelBodySchema>;

/** The label and note a publish may set on the draft it publishes (both optional). */
export const PublishLabelSchema = z
  .object({
    label: Label.optional().describe(
      `A label for the version, up to ${VERSION_LABEL_MAX} characters. Default: keep the draft's.`,
    ),
    note: Note.optional().describe(
      `A note for the version, up to ${VERSION_NOTE_MAX} characters. Default: keep the draft's.`,
    ),
  })
  .strict();

/** The label fields every recipe version carries. */
export const VersionLabelSchema = z.object({
  label: z.string().nullable().describe('What the version is for; null when unlabelled.'),
  note: z.string().nullable().describe('A longer comment; null when there is none.'),
  labelSetBy: z
    .string()
    .nullable()
    .describe('Who last set the label or note; null when never set or without access control.'),
  labelSetAt: z.string().nullable().describe('When the label or note was last set.'),
});
export type VersionLabel = z.infer<typeof VersionLabelSchema>;

/** "v3" or "v3 · Handles 2-page invoices". */
export const versionName = (version: number, label: string | null | undefined) =>
  label ? `v${version} · ${label}` : `v${version}`;
