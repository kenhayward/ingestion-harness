import {
  answersOf,
  defaultsKey,
  signatureOf,
  VALUE_NODE_DEFAULTS_PATH,
  type TemplateChangeSource,
} from '@ih/shared';
import type { FastifyInstance } from 'fastify';
import type { TemplateRecord, TemplateRepo } from '../templates/repo.js';
import type { MappingMemoryRepo, ReplaceResult, VoteInput } from './repo.js';

/**
 * Capturing what designers accept (docs/design/mapping-memory.md, section 4): wherever a
 * designer accepts a mapping (a hand save, an applied proposal, a restore, a publish) the recipe
 * votes; one vote per recipe and output, its newest version's answer. Imports do not vote until
 * a designer saves or publishes them.
 */

/** The change-log sources of a designer's own acceptance. */
export const COUNTING_SOURCES: readonly TemplateChangeSource[] = ['hand', 'proposal', 'restore'];

export interface CaptureDeps {
  /** The recipes, unwrapped (reading them records nothing). */
  templates: TemplateRepo;
  memory: MappingMemoryRepo;
  /** The recipe's Workbench project's data policy; null without a project (counts as local). */
  policyOf: (id: string) => Promise<'local' | 'external' | null>;
}

/** A recipe definition's votes: one per output its mapping answers (none without a mapping). */
export function votesOf(
  definition: Record<string, unknown>,
  version: number,
  external: boolean,
): VoteInput[] {
  return answersOf(definition).map(({ path, signature, answer, ontologies }) => {
    const defaults = path === VALUE_NODE_DEFAULTS_PATH;
    const sig = signatureOf(signature);
    return {
      path,
      kind: signature.kind,
      signatureKey: defaults ? defaultsKey(ontologies) : sig.key,
      name: signature.name,
      description: signature.description ?? '',
      type: signature.type ?? '',
      unit: sig.unit,
      table: signature.table ?? null,
      answer,
      ontologies,
      version,
      external,
    };
  });
}

/**
 * The version a recipe votes with: its open draft once a designer has written it (or it was
 * started from a published version), else its latest published version.
 */
async function votingVersion(templates: TemplateRepo, id: string): Promise<TemplateRecord | null> {
  const versions = (await templates.list()).filter((r) => r.id === id);
  const published = versions.filter((v) => v.status === 'published').at(-1) ?? null;
  const draft = versions.find((v) => v.status === 'draft');
  if (!draft) return published;
  const log = await templates.listChanges(id, draft.version);
  const reviewed = log.some((c) => COUNTING_SOURCES.includes(c.source) || c.source === 'started');
  return reviewed ? draft : published;
}

/** Replaces the recipe's votes with its voting version's answers (none when retired or gone). */
export async function recordRecipe(
  deps: CaptureDeps,
  id: string,
  by: string | null,
): Promise<ReplaceResult> {
  const retired = await deps.templates.retirement(id);
  const version = retired ? null : await votingVersion(deps.templates, id);
  const votes = version
    ? votesOf(version.definition, version.version, (await deps.policyOf(id)) === 'external')
    : [];
  return deps.memory.replaceVotes(id, votes, by);
}

/** Every recipe recorded again (the backfill, and the repair of anything missed). */
export async function reconcileAll(deps: CaptureDeps): Promise<void> {
  const ids = new Set([
    ...(await deps.templates.list()).map((r) => r.id),
    ...(await deps.memory.votedTemplates()),
  ]);
  for (const id of [...ids].sort()) await recordRecipe(deps, id, null);
}

type Record_ = (id: string, by: string | null) => Promise<void>;

/**
 * The recipes repo, recording the recipe's votes after every write that counts (a draft write
 * whose change is a designer's, a publish, a deleted draft, a retirement either way). Recording
 * never fails a write: its errors go to `record`'s own handling.
 */
export function rememberingTemplates(
  inner: TemplateRepo,
  record: Record_,
  onError: (err: unknown, id: string) => void = () => {},
): TemplateRepo {
  const safely = async (id: string, by: string | null) => {
    try {
      await record(id, by);
    } catch (err) {
      // Advisory: the reconcile on the next start repairs a missed recording.
      onError(err, id);
    }
  };
  const counts = (source: TemplateChangeSource | undefined) =>
    source !== undefined && COUNTING_SOURCES.includes(source);
  const overrides: Partial<TemplateRepo> = {
    async create(id, version, definition, status, change) {
      const out = await inner.create(id, version, definition, status, change);
      if (status === 'draft' && counts(change?.source)) await safely(id, change?.by ?? null);
      return out;
    },
    async updateDraft(id, version, definition, write) {
      const out = await inner.updateDraft(id, version, definition, write);
      if (out && counts(write?.change?.source)) await safely(id, write?.change?.by ?? null);
      return out;
    },
    async publish(id, version, by) {
      const out = await inner.publish(id, version, by);
      if (out) await safely(id, by ?? null);
      return out;
    },
    async deleteDraft(id, version) {
      const out = await inner.deleteDraft(id, version);
      if (out) await safely(id, null);
      return out;
    },
    async retire(id, by) {
      const out = await inner.retire(id, by);
      await safely(id, by);
      return out;
    },
    async unretire(id) {
      const out = await inner.unretire(id);
      await safely(id, null);
      return out;
    },
  };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) {
        return overrides[prop as keyof TemplateRepo];
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The capture's dependencies from the app's. */
export function captureDeps(deps: {
  templates: TemplateRepo;
  mappingMemory: MappingMemoryRepo;
  workbench: { getProject(id: string): Promise<{ dataPolicy: 'local' | 'external' } | null> };
}): CaptureDeps {
  return {
    templates: deps.templates,
    memory: deps.mappingMemory,
    policyOf: async (id) => (await deps.workbench.getProject(id))?.dataPolicy ?? null,
  };
}

/**
 * Records a recipe from a route that writes it without the recipes repo (the Workbench publish,
 * reset and delete): advisory, its failure is logged, never answered.
 */
export async function recordFromRoute(
  app: FastifyInstance,
  id: string,
  by: string | null,
): Promise<void> {
  try {
    await recordRecipe(captureDeps(app.deps), id, by);
  } catch (err) {
    app.log.warn({ err, id }, 'mapping memory not recorded');
  }
}

interface RememberedChange {
  op: string;
  field?: string;
  table?: string;
  remembered?: { entryId: string };
  rememberedColumns?: Record<string, { entryId: string }>;
}

/** The outputs a mapping change answers from the memory: path -> entry id. */
function rememberedOutputs(change: RememberedChange): [string, string][] {
  const out: [string, string][] = [];
  const path =
    change.op === 'setDocumentMapping'
      ? ''
      : change.op === 'putFieldMapping'
        ? change.field
        : change.op === 'putTableMapping'
          ? change.table
          : undefined;
  if (path !== undefined && change.remembered) out.push([path, change.remembered.entryId]);
  for (const [column, meta] of Object.entries(change.rememberedColumns ?? {})) {
    out.push([`${change.table}.${column}`, meta.entryId]);
  }
  return out;
}

/**
 * A decided mapping proposal (section 4): the applied changes that came from the memory mark
 * their votes as pre-selected (so a later edit refuses them), the ones left unselected are
 * refusals now. Advisory: a failure is logged, never answered.
 */
export async function noteDecision(
  app: FastifyInstance,
  projectId: string,
  changes: readonly unknown[],
  chosen: readonly number[],
  by: string | null,
): Promise<void> {
  try {
    const origins: Record<string, string> = {};
    for (const [i, change] of changes.entries()) {
      for (const [path, entryId] of rememberedOutputs(change as RememberedChange)) {
        if (chosen.includes(i)) origins[path] = entryId;
        else await app.deps.mappingMemory.addRefusal(entryId, projectId, path, by);
      }
    }
    if (Object.keys(origins).length) await app.deps.mappingMemory.setOrigins(projectId, origins);
  } catch (err) {
    app.log.warn({ err, projectId }, 'mapping memory decision not recorded');
  }
}
