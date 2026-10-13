import { z } from 'zod';
import { PROVIDER_KINDS } from './models.js';
import { DATA_POLICIES } from './workbench.js';

/**
 * LLM endpoints and their curated models as admins manage them (ADR 0010). The worker seeds
 * the .env defaults and builds its registry from the same tables (`llm/endpoints.py`).
 */
export const ENDPOINT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
export const ENDPOINT_LOCATIONS = DATA_POLICIES;

export const LlmModelViewSchema = z.object({
  modelId: z.string(),
  displayName: z.string().nullable(),
  /** Offered in the pickers; false: discovered on the endpoint, a suggestion. */
  curated: z.boolean(),
  enabled: z.boolean(),
});
export type LlmModelView = z.infer<typeof LlmModelViewSchema>;

export const LlmEndpointViewSchema = z.object({
  /** The model-ref prefix: `name/model-id`. */
  name: z.string(),
  kind: z.enum(PROVIDER_KINDS),
  baseUrl: z.string().nullable(),
  /** Data policy (ADR 0007): where requests to this endpoint go. */
  location: z.enum(ENDPOINT_LOCATIONS),
  enabled: z.boolean(),
  /** env: seeded from .env (until an admin edits it); ui: added by an admin. */
  source: z.enum(['env', 'ui']),
  /** When an admin last changed it; .env no longer changes it after that. */
  editedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
  /** The env variable the worker reads the key from (its value is never shown). */
  apiKeyEnv: z.string().nullable(),
  /** A key was entered in the UI (stored encrypted; never returned). */
  keySet: z.boolean(),
  models: z.array(LlmModelViewSchema),
});
export type LlmEndpointView = z.infer<typeof LlmEndpointViewSchema>;

const ModelId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^\S+$/, 'model ids have no spaces')
  .describe('A model id as the endpoint names it, e.g. `qwen3-32b`.');
const BaseUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u), 'http or https')
  .nullable();
const ApiKey = z.string().trim().min(1).max(1000);

export const EndpointCreateBodySchema = z
  .object({
    name: z.string().max(40).regex(ENDPOINT_NAME, 'lower-case letters, digits, - and _'),
    kind: z.enum(PROVIDER_KINDS),
    baseUrl: BaseUrl.default(null),
    location: z.enum(ENDPOINT_LOCATIONS),
    /** Stored encrypted (needs LLM_SECRETS_KEY). */
    apiKey: ApiKey.optional(),
    models: z.array(ModelId).max(200).default([]),
  })
  .strict()
  .refine((b) => b.kind === 'anthropic' || b.baseUrl !== null, {
    message: 'an OpenAI-compatible endpoint needs a base URL',
    path: ['baseUrl'],
  });
export type EndpointCreateBody = z.infer<typeof EndpointCreateBodySchema>;
/** What a client sends (defaults not applied yet). */
export type EndpointCreateInput = z.input<typeof EndpointCreateBodySchema>;

export const EndpointPatchBodySchema = z
  .object({
    kind: z.enum(PROVIDER_KINDS).optional(),
    baseUrl: BaseUrl.optional(),
    location: z.enum(ENDPOINT_LOCATIONS).optional(),
    enabled: z.boolean().optional(),
    /** A new key (stored encrypted), or null to remove the stored one. */
    apiKey: ApiKey.nullable().optional(),
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'nothing to change');
export type EndpointPatchBody = z.infer<typeof EndpointPatchBodySchema>;

export const CuratedModelsBodySchema = z.object({ models: z.array(ModelId).max(200) }).strict();

/** Follows aliases (`cheap` -> `default` -> `local/qwen`); null on a cycle or a dead end. */
export function resolveAlias(name: string, aliases: Record<string, string>): string | null {
  const seen = new Set<string>();
  let ref = name;
  while (ref in aliases) {
    if (seen.has(ref)) return null;
    seen.add(ref);
    ref = aliases[ref]!;
  }
  return ref.includes('/') ? ref : null;
}
