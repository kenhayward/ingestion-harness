import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import type { PluginInfo } from '@ih/shared';

const ajv = new Ajv2020({ allErrors: true, strict: false });
/** Compiled settings schemas, by ref and the schema itself (a new worker image may change it). */
const compiled = new Map<string, { schema: string; validate: ValidateFunction }>();

function validator(plugin: PluginInfo): ValidateFunction {
  const schema = JSON.stringify(plugin.settingsSchema);
  const known = compiled.get(plugin.ref);
  if (known?.schema === schema) return known.validate;
  const validate = ajv.compile(plugin.settingsSchema);
  compiled.set(plugin.ref, { schema, validate });
  return validate;
}

const describe = (e: ErrorObject): string => {
  const where = e.instancePath ? `${e.instancePath} ` : '';
  const extra =
    e.keyword === 'additionalProperties'
      ? ` (${String((e.params as { additionalProperty?: unknown }).additionalProperty)})`
      : '';
  return `${where}${e.message ?? 'is not valid'}${extra}`;
};

/**
 * Why a plugin step's `with` does not fit the plugin's settings schema (empty: it fits). Rules
 * beyond the schema (a pattern that must compile, a field the step must fill) stay the worker's,
 * checked when the job runs.
 */
export function settingsProblems(plugin: PluginInfo, settings: unknown): string[] {
  const validate = validator(plugin);
  if (validate(settings ?? {})) return [];
  return (validate.errors ?? [])
    .filter((e) => e.keyword !== 'anyOf') // the branch that failed says why
    .map(describe);
}
