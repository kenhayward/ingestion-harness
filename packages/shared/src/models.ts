import { z } from 'zod';

/** Provider kinds supported by the worker's LLM layer (worker/src/ingest_worker/llm). */
export const PROVIDER_KINDS = ['anthropic', 'openai-chat', 'openai-responses'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** A model as recorded in the llm_models table by worker discovery. */
export const ModelInfoSchema = z.object({
  /** "provider/model-id" — the reference used in specs and job overrides. */
  ref: z.string(),
  provider: z.string(),
  providerKind: z.enum(PROVIDER_KINDS),
  modelId: z.string(),
  displayName: z.string().nullable(),
  enabled: z.boolean(),
  discoveredAt: z.string(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export function modelRef(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export function parseModelRef(ref: string): { provider: string; modelId: string } | null {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}
