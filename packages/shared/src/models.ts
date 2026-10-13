import { z } from 'zod';

/** Provider kinds supported by the worker's LLM layer (worker/src/ingest_worker/llm). */
export const PROVIDER_KINDS = ['anthropic', 'openai-chat', 'openai-responses'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * A model in the llm_models table: seeded from .env, curated by an admin or found by worker
 * discovery (ADR 0010).
 */
export const ModelInfoSchema = z.object({
  /** "provider/model-id" — the reference used in specs and job overrides. */
  ref: z.string(),
  provider: z.string(),
  providerKind: z.enum(PROVIDER_KINDS),
  modelId: z.string(),
  displayName: z.string().nullable(),
  enabled: z.boolean(),
  discoveredAt: z.string(),
  /**
   * Chosen for the pickers (.env or an admin), on an endpoint that exists and is enabled. A
   * discovered model that is not curated is only a suggestion.
   */
  curated: z.boolean(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

/** Offered in the model pickers, and accepted as a job's or retry's model override. */
export const isOffered = (m: Pick<ModelInfo, 'enabled' | 'curated'>): boolean =>
  m.enabled && m.curated;

export function modelRef(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export function parseModelRef(ref: string): { provider: string; modelId: string } | null {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}
