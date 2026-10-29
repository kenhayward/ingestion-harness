import { z } from 'zod';
import { CredentialSchema, DestinationFieldSchema } from './fields.js';
import { ActingUserSchema } from './package.js';

/** The folders a watched location has: the root, then three beneath it. */
export const SOURCE_FOLDERS = ['', 'processing', 'delivered', 'failed'] as const;
export const SourceFolderSchema = z.enum(SOURCE_FOLDERS);
export type SourceFolder = z.infer<typeof SourceFolderSchema>;

export const MAX_SOURCE_NAME = 255;
export const MAX_SOURCE_CONTENT = 65_536;

/** Why `name` is not one file name (a single path segment), or null. */
export function sourceNameProblem(name: string): string | null {
  if (name.length < 1 || name.length > MAX_SOURCE_NAME) {
    return `a file name is 1 to ${MAX_SOURCE_NAME} characters`;
  }
  if (name === '.' || name === '..') return 'a file name cannot be . or ..';
  const codes = [47, 92, 0];
  if ([...name].some((ch) => codes.includes(ch.charCodeAt(0)))) {
    return 'a file name is one path segment: no slash, backslash or NUL';
  }
  return null;
}

export const SourceNameSchema = z.string().superRefine((name, ctx) => {
  const problem = sourceNameProblem(name);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

/** Version 4: where the sink's watched folders are set, and how they are browsed. */
export const WatchedFoldersSchema = z.strictObject({
  sourceFields: z.array(DestinationFieldSchema).min(1),
});
export type WatchedFolders = z.infer<typeof WatchedFoldersSchema>;

export const SourceFileSchema = z.strictObject({
  name: SourceNameSchema,
  size: z.number().int().nonnegative(),
  modifiedAt: z.string().datetime(),
  etag: z.string().nullable(),
});
export type SourceFile = z.infer<typeof SourceFileSchema>;

export const SourcePlaceSchema = z.strictObject({
  folder: SourceFolderSchema,
  name: SourceNameSchema,
});

/** What every call carries: which watched location, and on whose behalf. */
const where = {
  source: z.record(z.string(), z.string()),
  actingUser: ActingUserSchema.nullable(),
};

/** The bodies a producer sends the bridge (it fills in the instance and credential). */
export const ProducerSourceListSchema = z.strictObject({ ...where, folder: SourceFolderSchema });
export const ProducerSourceReadSchema = z.strictObject({
  ...where,
  folder: SourceFolderSchema,
  name: SourceNameSchema,
});
export const ProducerSourceMoveSchema = z.strictObject({
  ...where,
  from: SourcePlaceSchema,
  to: SourcePlaceSchema,
});
export const ProducerSourcePutSchema = z.strictObject({
  ...where,
  folder: SourceFolderSchema,
  name: SourceNameSchema,
  content: z.string().max(MAX_SOURCE_CONTENT),
});

/** The bodies the bridge sends a sink. */
const toSink = { instanceId: z.string(), credential: CredentialSchema, ...where };
export const SourceListRequestSchema = z.strictObject({ ...toSink, folder: SourceFolderSchema });
export const SourceReadRequestSchema = z.strictObject({
  ...toSink,
  folder: SourceFolderSchema,
  name: SourceNameSchema,
});
export const SourceMoveRequestSchema = z.strictObject({
  ...toSink,
  from: SourcePlaceSchema,
  to: SourcePlaceSchema,
});
export const SourcePutRequestSchema = z.strictObject({
  ...toSink,
  folder: SourceFolderSchema,
  name: SourceNameSchema,
  content: z.string().max(MAX_SOURCE_CONTENT),
});
export type SourceListRequest = z.infer<typeof SourceListRequestSchema>;
export type SourceReadRequest = z.infer<typeof SourceReadRequestSchema>;
export type SourceMoveRequest = z.infer<typeof SourceMoveRequestSchema>;
export type SourcePutRequest = z.infer<typeof SourcePutRequestSchema>;

export const SourceListAnswerSchema = z.strictObject({ files: z.array(SourceFileSchema) });
export type SourceListAnswer = z.infer<typeof SourceListAnswerSchema>;

/** A folder that does not exist is `not_found` with this `details.reason`. */
export const FOLDER_MISSING_REASON = 'folder_missing';

export const SOURCE_PATHS = {
  list: '/sources::list',
  read: '/sources::read',
  move: '/sources::move',
  put: '/sources::put',
} as const;
