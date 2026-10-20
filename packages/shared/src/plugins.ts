import { z } from 'zod';
import { JobStatusSchema } from './jobs.js';
import { PLUGIN_REF } from './template.js';

/**
 * One plugin a deployment's workers can run, as the worker publishes it at start (the plugin
 * catalogue, docs/design/recipe-plugins.md slice 3b; worker `plugin_catalogue.catalogue_rows`,
 * held in step by the shared fixture `test/fixtures/plugin-catalogue.json`).
 */
export const PluginInfoSchema = z.object({
  /** `<id>@<major>`: what a recipe's plugin step names in `uses`. */
  ref: z.string().regex(PLUGIN_REF),
  id: z.string().min(1),
  major: z.number().int().positive(),
  summary: z.string(),
  /** What a recipe uses it as: a pipeline `step` (plugin step) or a `check` (check step). */
  kind: z.enum(['step', 'check']),
  /** Whether it sends data out: `none`, or to a `model` (through the data-policy gate). */
  egress: z.enum(['none', 'model', 'remote']),
  /** The JSON Schema of the step's `with` (draft 2020-12, as Pydantic writes it). */
  settingsSchema: z.record(z.string(), z.unknown()),
});
export type PluginInfo = z.infer<typeof PluginInfoSchema>;

/** A plugin step preview (recipe plugins 3c): which step, on which dev samples. */
export const PluginPreviewBodySchema = z
  .object({
    /** A plugin step of the open draft. */
    stepId: z.string().min(1),
    /** Ready dev samples (default: every one). */
    sampleIds: z.array(z.string().uuid()).min(1).max(50).optional(),
  })
  .strict();

/** One sample's preview, as the worker writes it (`plugin_preview.preview_samples`). */
export const PluginPreviewSampleSchema = z.object({
  sampleId: z.string(),
  fileName: z.string(),
  /** A field step's values, typed as a run's would be (`{value, evidence, page}`); else null. */
  fields: z.record(z.string(), z.record(z.string(), z.unknown())).nullable(),
  /** A table step's rows, typed; else null. */
  rows: z.array(z.record(z.string(), z.unknown())).nullable(),
  /** Values that could not be typed, as a run lists them. */
  issues: z.array(z.record(z.string(), z.unknown())),
  /** Why this sample could not be previewed (not prepared, a missing section, the plugin failed). */
  error: z.string().nullable(),
});
export type PluginPreviewSample = z.infer<typeof PluginPreviewSampleSchema>;

/** Written by the worker's `plugin` task (runs bucket, `pluginPreviewKey`). */
export const PluginPreviewResultSchema = z.object({
  stepId: z.string(),
  uses: z.string(),
  /** Why the preview could not run at all (its settings, the time limit); null when it ran. */
  problem: z.string().nullable(),
  samples: z.array(PluginPreviewSampleSchema),
});
export type PluginPreviewResult = z.infer<typeof PluginPreviewResultSchema>;

export const PluginPreviewViewSchema = z.object({
  jobId: z.string().uuid(),
  status: JobStatusSchema,
  error: z.string().nullable(),
  /** Present once the job succeeded. */
  result: PluginPreviewResultSchema.nullable(),
});
export type PluginPreviewView = z.infer<typeof PluginPreviewViewSchema>;
