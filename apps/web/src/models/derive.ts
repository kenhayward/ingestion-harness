import type { LlmEndpointView, LlmModelView } from '@ih/shared';

/** A model an endpoint offers: what a choice or a pipeline model may point at. */
export interface OfferedModel {
  /** `endpoint/model-id`, what is stored. */
  ref: string;
  endpoint: string;
  modelId: string;
  /** Its display name, else its id. */
  name: string;
  location: LlmEndpointView['location'];
}

export const modelName = (m: LlmModelView) => m.displayName ?? m.modelId;

/** The models offered on enabled endpoints, by ref. */
export function offeredModels(endpoints: readonly LlmEndpointView[]): OfferedModel[] {
  return endpoints
    .filter((e) => e.enabled)
    .flatMap((e) =>
      e.models
        .filter((m) => m.curated && m.enabled)
        .map((m) => ({
          ref: `${e.name}/${m.modelId}`,
          endpoint: e.name,
          modelId: m.modelId,
          name: modelName(m),
          location: e.location,
        })),
    )
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * What a stored ref points at, by name: any model an endpoint knows, offered or not. Null for a
 * ref no endpoint has (the caller shows the ref).
 */
export function modelAt(
  ref: string,
  endpoints: readonly LlmEndpointView[],
): { name: string; endpoint: string; location: LlmEndpointView['location'] } | null {
  const slash = ref.indexOf('/');
  const e = endpoints.find((x) => x.name === ref.slice(0, slash));
  const m = e?.models.find((x) => x.modelId === ref.slice(slash + 1));
  return e && m ? { name: modelName(m), endpoint: e.name, location: e.location } : null;
}

/** A select option for a ref: "Qwen 3 · local", else the ref itself. */
export function optionText(ref: string, endpoints: readonly LlmEndpointView[]): string {
  const at = modelAt(ref, endpoints);
  return at ? `${at.name} · ${at.endpoint}` : ref;
}

/** Where an endpoint's settings came from, as the second half of "Local · from .env". */
export function sourceText(e: LlmEndpointView): string {
  if (e.source === 'ui') return e.updatedBy ? `added here by ${e.updatedBy}` : 'added here';
  if (!e.editedAt) return 'from .env';
  return e.updatedBy ? `edited by ${e.updatedBy}` : 'edited here';
}
