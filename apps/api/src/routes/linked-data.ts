import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  LinkedDataBodySchema,
  LinkedDataViewSchema,
  baseIriProblem,
  effectiveBaseIri,
  type LinkedDataView,
} from '@ih/shared';
import { error, md, res } from '../openapi/zod.js';

/** Linked data settings (ADR 0011): the customer and the base IRI RDF is minted under. */

const ADMINS_ONLY = error('`admins only`.');
const EffectiveBase = z.object({ effectiveBase: z.string().nullable() });

export async function linkedDataRoutes(app: FastifyInstance): Promise<void> {
  const by = (req: FastifyRequest) => req.auth?.label ?? null;
  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.deps.access && req.auth?.role !== 'admin') {
      return reply.code(403).send({ error: 'admins only' });
    }
  };
  const base = (operationId: string, summary: string, description: string) => ({
    tags: ['Linked data'],
    operationId,
    summary,
    description,
  });

  const view = async (): Promise<LinkedDataView> => {
    const { linkedData } = app.deps;
    const [settings, history, rdfPublished] = await Promise.all([
      linkedData.get(),
      linkedData.history(),
      linkedData.rdfPublishedCount(),
    ]);
    const effectiveBase = effectiveBaseIri(settings);
    const graphs = await linkedData.graphStatus(effectiveBase);
    return { settings, effectiveBase, rdfPublished, graphs, history };
  };

  app.get(
    '/linked-data/settings',
    {
      preHandler: adminOnly,
      schema: {
        ...base(
          'getLinkedDataSettings',
          'Linked data settings',
          md`
            **Admin token required.** The deployment's customer, the base IRI its RDF is minted
            under (the customer's own, else \`https://id.stocks-hayward.com/<customer>/\`), how
            many RDF outputs were published, and the history of base changes.
          `,
        ),
        'x-admin': true,
        response: { 200: res('The settings.', LinkedDataViewSchema), 403: ADMINS_ONLY },
      },
    },
    async () => view(),
  );

  app.put(
    '/linked-data/settings',
    {
      preHandler: adminOnly,
      schema: {
        ...base(
          'saveLinkedDataSettings',
          'Save the linked data settings',
          md`
            **Admin token required.** Sets the customer and, optionally, their own base IRI
            (https, ending in \`/\`, a host name). IRIs are identities: once RDF was published,
            changing the effective base needs \`confirm\` equal to the new base, applies to new
            publishes only, and is recorded in the history.
          `,
        ),
        'x-admin': true,
        body: LinkedDataBodySchema,
        response: {
          200: res('The settings.', LinkedDataViewSchema),
          400: error('An invalid body or base IRI.'),
          403: ADMINS_ONLY,
          409: error('RDF was published under the old base: repeat the new base in `confirm`.'),
        },
      },
    },
    async (req, reply) => {
      const body = LinkedDataBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { customerName, customerSlug, baseIri, confirm } = body.data;
      const problem = baseIri ? baseIriProblem(baseIri) : null;
      if (problem) return reply.code(400).send({ error: problem });
      const { linkedData } = app.deps;
      const before = effectiveBaseIri(await linkedData.get());
      const after = effectiveBaseIri({ customerSlug, baseIri });
      if (before && before !== after) {
        const published = await linkedData.rdfPublishedCount();
        if (published > 0 && confirm !== after) {
          return reply.code(409).send({
            error: `${published} RDF outputs were published under ${before}: confirm the new base to change it`,
          });
        }
      }
      await linkedData.save({ customerName, customerSlug, baseIri }, by(req));
      if (before !== after) {
        req.log.info({ from: before, to: after, by: by(req) }, 'linked data base changed');
      }
      return view();
    },
  );

  app.get(
    '/linked-data/base',
    {
      schema: {
        ...base(
          'getLinkedDataBase',
          'The base IRI RDF is minted under',
          md`
            The effective base IRI, for showing example IRIs while mapping a recipe. Null until
            an admin sets the customer on the Linked data page (RDF is skipped until then).
          `,
        ),
        response: { 200: res('The effective base.', EffectiveBase) },
      },
    },
    async () => ({ effectiveBase: effectiveBaseIri(await app.deps.linkedData.get()) }),
  );
}
