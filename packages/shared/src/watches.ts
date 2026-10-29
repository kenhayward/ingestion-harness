import { z } from 'zod';
import { TargetIdSchema } from './publish-targets.js';

/**
 * Watched folders (plan 3, docs/superpowers/specs/2026-10-29-watched-folders-design.md): an
 * admin points CT Studio at a folder of a sink; the worker picks files up from its root and
 * converts them in a batch the watch owns. Pure and browser-safe.
 */
export const WATCH_STATES = ['running', 'draining', 'stopped'] as const;
export const WatchStateSchema = z.enum(WATCH_STATES);
export type WatchState = z.infer<typeof WatchStateSchema>;

export type WatchHealth = 'running' | 'draining' | 'stopped' | 'problem';

export const WATCH_SLEEP = { min: 10, max: 3600, default: 30 } as const;
export const WATCH_ADMIT = { min: 1, max: 100, default: 10 } as const;

const NameSchema = z.string().trim().min(1).max(80);

/** The settings an admin chooses; `source` holds the sink's source field values by field id. */
export const WatchSettingsSchema = z
  .object({
    name: NameSchema,
    targetId: TargetIdSchema,
    source: z.record(z.string(), z.string()),
    force: z.boolean(),
    autoApprove: z.boolean(),
    reasonFiles: z.boolean(),
    sleepSeconds: z.number().int().min(WATCH_SLEEP.min).max(WATCH_SLEEP.max),
    admit: z.number().int().min(WATCH_ADMIT.min).max(WATCH_ADMIT.max),
  })
  .strict();
export type WatchSettings = z.infer<typeof WatchSettingsSchema>;

/** Who the watch delivers as (null parts without access control). */
export const WatchRunAsSchema = z
  .object({ id: z.string().nullable(), name: z.string().nullable(), email: z.string().nullable() })
  .strict();
export type WatchRunAs = z.infer<typeof WatchRunAsSchema>;

const FiguresSchema = z.object({ delivered: z.number().int(), failed: z.number().int() }).strict();

export const WatchViewSchema = WatchSettingsSchema.extend({
  id: z.string().uuid(),
  state: WatchStateSchema,
  health: z.enum(['running', 'draining', 'stopped', 'problem']),
  problem: z.string().nullable(),
  sourcePath: z.string(),
  runAs: WatchRunAsSchema,
  queue: z.object({ waiting: z.number().int(), inProgress: z.number().int() }).strict(),
  throughput: z.object({ day: FiguresSchema, total: FiguresSchema }).strict(),
  lastPickupAt: z.string().nullable(),
  batchId: z.string().uuid().nullable(),
  createdAt: z.string(),
}).strict();
export type WatchView = z.infer<typeof WatchViewSchema>;

export const WATCH_EVENT_LEVELS = ['info', 'warn', 'error'] as const;
export const WatchEventSchema = z
  .object({
    id: z.number().int(),
    at: z.string(),
    level: z.enum(WATCH_EVENT_LEVELS),
    message: z.string(),
    details: z.unknown().nullable(),
  })
  .strict();
export type WatchEvent = z.infer<typeof WatchEventSchema>;

/** A new watch: the optional settings take their defaults. */
export const WatchCreateBodySchema = z
  .object({
    name: NameSchema,
    targetId: TargetIdSchema,
    source: z.record(z.string(), z.string()),
    force: z.boolean().default(false),
    autoApprove: z.boolean().default(true),
    reasonFiles: z.boolean().default(true),
    sleepSeconds: WatchSettingsSchema.shape.sleepSeconds.default(WATCH_SLEEP.default),
    admit: WatchSettingsSchema.shape.admit.default(WATCH_ADMIT.default),
  })
  .strict();
export type WatchCreateBody = z.infer<typeof WatchCreateBodySchema>;

/** A change: any setting left out is kept. The folder and target change only while stopped. */
export const WatchPatchBodySchema = WatchSettingsSchema.partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'change at least one setting' });
export type WatchPatchBody = z.infer<typeof WatchPatchBodySchema>;

export const StopBodySchema = z.object({ mode: z.enum(['now', 'drain']) }).strict();
export type StopBody = z.infer<typeof StopBodySchema>;

/** The settings that identify what is watched: changeable only while the watch is stopped. */
export const WATCH_LOCKED_SETTINGS = ['targetId', 'source'] as const;

/** A problem wins over running and draining; a stopped watch is never a problem. */
export function healthOf(w: { state: WatchState; problem: string | null }): WatchHealth {
  if (w.state === 'stopped') return 'stopped';
  return w.problem ? 'problem' : w.state;
}

/**
 * The folder path a watch reads: the values of the sink's source fields joined with `/`, in the
 * order the sink declares them. Values for fields the sink does not declare are ignored; a
 * declared field with no value contributes nothing; stray slashes are trimmed.
 */
export function watchSourcePath(
  fields: readonly { id: string }[],
  source: Record<string, string>,
): string {
  return fields
    .map((f) => (source[f.id] ?? '').trim().replace(/^\/+|\/+$/g, ''))
    .filter((v) => v !== '')
    .join('/');
}
