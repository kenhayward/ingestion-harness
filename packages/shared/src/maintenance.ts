import { z } from 'zod';

/**
 * Maintenance mode (migration 0046): an admin takes CT Studio down for everyone but admins while
 * models are swapped or a deploy runs, with a message the sign-in page and the app show.
 */

export const MAINTENANCE_MESSAGE_MAX = 1000;

/** Shown when the admin left the message blank. */
export const DEFAULT_MAINTENANCE_MESSAGE =
  'CT Studio is down for maintenance. Please try again later.';

/** The `error` of the 503 the API answers people who are not admins while it is on. */
export const MAINTENANCE_ERROR = 'CT Studio is under maintenance';

/** What anyone may read, signed in or not: the sign-in page shows it. */
export const MaintenanceNoticeSchema = z.object({
  enabled: z.boolean().describe('On: only admins can sign in and use the API.'),
  message: z
    .string()
    .describe('The message for users (blank: the default one); kept when switched off.'),
  since: z.string().datetime().nullable().describe('When it was switched on; null while off.'),
});
export type MaintenanceNotice = z.infer<typeof MaintenanceNoticeSchema>;

/** What admins see: the notice and who changed it last. */
export const MaintenanceViewSchema = MaintenanceNoticeSchema.extend({
  updatedBy: z.string().nullable().describe('The admin who changed it last; null: never changed.'),
  updatedAt: z.string().datetime().nullable().describe('When it was changed last.'),
});
export type MaintenanceView = z.infer<typeof MaintenanceViewSchema>;

export const MaintenanceBodySchema = z
  .object({
    enabled: z.boolean(),
    message: z.string().trim().max(MAINTENANCE_MESSAGE_MAX),
  })
  .strict();
export type MaintenanceBody = z.infer<typeof MaintenanceBodySchema>;

/** The 503 body: the error and the notice, so a client can show the message at once. */
export const MaintenanceRefusalSchema = z.object({
  error: z.literal(MAINTENANCE_ERROR),
  maintenance: MaintenanceNoticeSchema,
});

/** The message to show: the admin's, else the default. */
export const maintenanceMessage = (notice: Pick<MaintenanceNotice, 'message'>) =>
  notice.message.trim() || DEFAULT_MAINTENANCE_MESSAGE;
