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
  /**
   * The most tokens one reply may use where the step does not say (Workbench drafting and
   * mapping); null: the default, DEFAULT_MAX_OUTPUT_TOKENS.
   */
  maxOutputTokens: z.number().int().nullable(),
});
export type LlmModelView = z.infer<typeof LlmModelViewSchema>;

/** A drafting or mapping reply's output budget when its model sets none (worker DRAFT_MAX_TOKENS). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
export const MIN_OUTPUT_TOKENS = 1024;
export const MAX_OUTPUT_TOKENS = 1_000_000;

/** `PATCH /api/llm/endpoints/:name/models/:modelId`: a model's output limit (null: the default). */
export const ModelSettingsBodySchema = z
  .object({
    maxOutputTokens: z.number().int().min(MIN_OUTPUT_TOKENS).max(MAX_OUTPUT_TOKENS).nullable(),
  })
  .strict();
export type ModelSettingsBody = z.infer<typeof ModelSettingsBodySchema>;

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

/**
 * Why a model ref (or alias) may not run, or null when it may: only models offered on their
 * endpoint run (ADR 0010; the worker enforces the same). `unknownAliases: 'allow'` leaves an
 * alias name the database doesn't define to the worker (template checks: unit tests run with
 * no aliases).
 */
export function modelRefProblem(
  ref: string,
  offered: ReadonlySet<string>,
  aliases: Record<string, string>,
  { unknownAliases = 'refuse' }: { unknownAliases?: 'refuse' | 'allow' } = {},
): string | null {
  const notOffered = 'is not offered: add it under Administration > Models';
  if (ref in aliases) {
    const resolved = resolveAlias(ref, aliases);
    if (resolved === null) return `model choice ${ref} does not resolve to a model`;
    return offered.has(resolved)
      ? null
      : `model choice ${ref} uses ${resolved}, which ${notOffered}`;
  }
  if (ref.includes('/')) return offered.has(ref) ? null : `model ${ref} ${notOffered}`;
  return unknownAliases === 'allow' ? null : `unknown model choice ${ref}`;
}

/**
 * Model choices (ADR 0010, phase 4b): what people pick, by label. Templates and jobs store the
 * id, so a label can change. One is the default (`settings.defaultChoice`), used by template
 * steps that name none. The OCR and drafting models are pipeline settings, never a choice.
 */
export const RESERVED_CHOICE_IDS = ['default', 'draft', 'ocr'] as const;
const ChoiceId = z
  .string()
  .max(40)
  .regex(ENDPOINT_NAME, 'lower-case letters, digits, - and _')
  .refine((id) => !(RESERVED_CHOICE_IDS as readonly string[]).includes(id), 'reserved');
/** endpoint/model-id: the first `/` ends the endpoint, the model id may hold more. */
const ModelRef = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]*\/\S+$/, 'endpoint/model-id')
  .max(250);
const Label = z.string().trim().min(1).max(80);
const Description = z.string().trim().max(300);

export const LlmChoiceViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  /** The offered model it points at (`endpoint/model-id`). */
  ref: z.string(),
  source: z.enum(['env', 'ui']),
  editedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type LlmChoiceView = z.infer<typeof LlmChoiceViewSchema>;

export const LlmSettingsViewSchema = z.object({
  /** The choice template steps use when they name none. */
  defaultChoice: z.string().nullable(),
  /** The Workbench's drafting stages and dev reference runs. */
  draftingModel: z.string().nullable(),
  /** The OCR stage only. */
  ocrModel: z.string().nullable(),
  /** Ontology term and output embeddings for the mapping stage (ADR 0011); null: lexical only. */
  embeddingModel: z.string().nullable(),
});
export type LlmSettingsView = z.infer<typeof LlmSettingsViewSchema>;

export const LlmChoicesViewSchema = z.object({
  choices: z.array(LlmChoiceViewSchema),
  settings: LlmSettingsViewSchema,
});
export type LlmChoicesView = z.infer<typeof LlmChoicesViewSchema>;

export const ChoiceCreateBodySchema = z
  .object({
    /** Made from the label when left out. */
    id: ChoiceId.optional(),
    label: Label,
    description: Description.default(''),
    ref: ModelRef,
  })
  .strict();
export type ChoiceCreateInput = z.input<typeof ChoiceCreateBodySchema>;

export const ChoicePatchBodySchema = z
  .object({
    label: Label.optional(),
    description: Description.optional(),
    ref: ModelRef.optional(),
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'nothing to change');
export type ChoicePatchBody = z.infer<typeof ChoicePatchBodySchema>;

export const SettingsBodySchema = z
  .object({
    defaultChoice: z.string().min(1).optional(),
    draftingModel: ModelRef.optional(),
    ocrModel: ModelRef.optional(),
    /** null clears it: the mapping stage then retrieves terms lexically. */
    embeddingModel: ModelRef.nullable().optional(),
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'nothing to change');
export type SettingsBody = z.infer<typeof SettingsBodySchema>;

/** A choice id from its label: "Main Production Model" -> `main-production-model`. */
export function choiceIdFrom(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
    .replace(/-+$/, '');
  return slug && !(RESERVED_CHOICE_IDS as readonly string[]).includes(slug) ? slug : 'choice';
}

/**
 * The names a user's pick may use, as `modelRefProblem` takes them: each choice's id and
 * `default` (the default choice, for template steps naming none). Never the drafting or OCR
 * model: those belong to the pipeline.
 */
export function choiceNames(
  choices: readonly Pick<LlmChoiceView, 'id' | 'ref'>[],
  settings: Pick<LlmSettingsView, 'defaultChoice'>,
): Record<string, string> {
  const names: Record<string, string> = Object.fromEntries(choices.map((c) => [c.id, c.ref]));
  if (settings.defaultChoice) names.default = settings.defaultChoice;
  return names;
}

/** What points at a model: each choice and the two pipeline models (endpoint guards). */
export function modelUses(
  choices: readonly Pick<LlmChoiceView, 'label' | 'ref'>[],
  settings: Pick<LlmSettingsView, 'draftingModel' | 'ocrModel'> &
    Partial<Pick<LlmSettingsView, 'embeddingModel'>>,
): { what: string; ref: string }[] {
  return [
    ...choices.map((c) => ({ what: `model choice ${c.label}`, ref: c.ref })),
    ...(settings.draftingModel
      ? [{ what: 'the drafting model', ref: settings.draftingModel }]
      : []),
    ...(settings.ocrModel ? [{ what: 'the OCR model', ref: settings.ocrModel }] : []),
    ...(settings.embeddingModel
      ? [{ what: 'the embedding model', ref: settings.embeddingModel }]
      : []),
  ];
}

/**
 * A model choice as everyone sees it in the pickers (ADR 0010, phase 4c): by label, with the
 * model it runs and where that model runs (a local-only project cannot pick an external one).
 */
export const ModelChoiceSchema = z.object({
  /** What templates and jobs store. */
  id: z.string(),
  label: z.string(),
  description: z.string(),
  /** The model it runs (`endpoint/model-id`). */
  ref: z.string(),
  /** The endpoint's location; an endpoint nobody declared is external. */
  location: z.enum(ENDPOINT_LOCATIONS),
  /** Used by template steps that name no model. */
  isDefault: z.boolean(),
});
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;

/** The choices people may pick: offered ones only, the default first, then by label. */
export function pickerChoices(
  choices: readonly LlmChoiceView[],
  settings: Pick<LlmSettingsView, 'defaultChoice'>,
  endpoints: readonly Pick<LlmEndpointView, 'name' | 'location'>[],
  offered: ReadonlySet<string>,
): ModelChoice[] {
  const location = new Map(endpoints.map((e) => [e.name, e.location]));
  return choices
    .filter((c) => offered.has(c.ref))
    .map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      ref: c.ref,
      location: location.get(c.ref.slice(0, c.ref.indexOf('/'))) ?? 'external',
      isDefault: c.id === settings.defaultChoice,
    }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label));
}

/** The choice a pick names (`default` is the default choice); null for anything else. */
export function pickedChoice(name: string, choices: readonly ModelChoice[]): ModelChoice | null {
  return choices.find((c) => (name === 'default' ? c.isDefault : c.id === name)) ?? null;
}
