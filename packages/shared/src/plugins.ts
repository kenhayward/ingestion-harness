import { z } from 'zod';
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
  /** Whether it sends data out: `none`, or to a `model` (through the data-policy gate). */
  egress: z.enum(['none', 'model', 'remote']),
  /** The JSON Schema of the step's `with` (draft 2020-12, as Pydantic writes it). */
  settingsSchema: z.record(z.string(), z.unknown()),
});
export type PluginInfo = z.infer<typeof PluginInfoSchema>;
