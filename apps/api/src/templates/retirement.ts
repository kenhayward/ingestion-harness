import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { retiredMessage } from '@ih/shared';
import type { AppDeps } from '../app.js';

type Deps = Pick<AppDeps, 'templates' | 'specs'>;

/** For route docs: the 409 a retired document type answers. */
export const RETIRED_DOC =
  '`{name} is retired: unretire it to use it again` for a retired document type';

/** A document type is a database recipe (any version) or a file definition in `specs/`. */
export async function typeExists(deps: Deps, id: string): Promise<boolean> {
  return deps.specs.get(id) !== undefined || (await deps.templates.list()).some((r) => r.id === id);
}

/** The name people know a type by: its newest recipe's name, else its spec title, else the id. */
export async function typeTitle(deps: Deps, id: string): Promise<string> {
  const newest = (await deps.templates.list()).filter((r) => r.id === id).at(-1);
  if (newest) return String(newest.definition.name ?? id);
  const file = deps.specs.get(id);
  if (file) return file.kind === 'spec' ? file.spec.title : file.template.name;
  return id;
}

/** The 409 text when the type is retired (no new work for it), else null. */
export async function retiredProblem(deps: Deps, id: string): Promise<string | null> {
  if (!(await deps.templates.retirement(id))) return null;
  return retiredMessage(await typeTitle(deps, id));
}

/**
 * preHandler for routes whose `:id` is a document type (or its Workbench project): a retired
 * type is refused before the handler runs (it runs after body parsing, so it reads only
 * `req.params.id`), so nothing is queued or written. Routes keyed by a job id or by a body or
 * multipart field call `retiredProblem` inside the handler, before storing or queueing.
 */
export const refuseRetired =
  (app: FastifyInstance) => async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id?: string };
    if (id === undefined) return;
    const problem = await retiredProblem(app.deps, id);
    if (problem) return reply.code(409).send({ error: problem });
  };
