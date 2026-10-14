import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ONTOLOGY_ACCEPT,
  ONTOLOGY_ID_RE,
  OntologyDetailSchema,
  OntologyPatchSchema,
  OntologySummarySchema,
  OntologyVersionViewSchema,
  TAG_RE,
  TermDetailSchema,
  TermPageSchema,
  TermQuerySchema,
  ontologyFormat,
  ontologyNormalizedKey,
  ontologySourceKey,
} from '@ih/shared';
import { binary, error, md, multipart, noContent, res } from '../openapi/zod.js';
import { multipartField } from '../uploads.js';
import { contentDisposition } from './jobs.js';

/** The ontology library (ADR 0011): anyone signed in reads, admins import and manage. */

const ADMINS_ONLY = error('`admins only`.');
const NOT_FOUND = error('No such ontology or version.');
const IdParams = z.object({ id: z.string().describe('Ontology id, e.g. `idmp-o`.') });
const VersionParams = IdParams.extend({
  version: z.coerce.number().int().positive().describe('Version number (1 is the first import).'),
});
const ListQuery = z.object({
  retired: z.enum(['include']).optional().describe('`include` lists retired ontologies too.'),
});
const SOURCE_TYPES = [
  'text/turtle',
  'application/rdf+xml',
  'application/ld+json',
  'application/n-triples',
  'text/n3',
];

const ID_RULE =
  'id must be 2-63 lowercase letters, digits or dashes, starting with a letter or digit';
const NAME_REQUIRED = 'name is required for a new ontology';

/** Comma-separated tags from the multipart field; every tag must match TAG_RE. */
function parseTags(raw: string | undefined): { tags: string[] } | { error: string } {
  const tags = (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const bad = tags.find((t) => !TAG_RE.test(t));
  return bad === undefined
    ? { tags }
    : {
        error: `tag "${bad}" must be lowercase letters, digits and : . _ - (for example industry:pharma)`,
      };
}

export async function ontologyRoutes(app: FastifyInstance): Promise<void> {
  const by = (req: FastifyRequest) => req.auth?.label ?? null;
  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.deps.access && req.auth?.role !== 'admin') {
      return reply.code(403).send({ error: 'admins only' });
    }
  };
  const base = (operationId: string, summary: string, description: string) => ({
    tags: ['Ontologies'],
    operationId,
    summary,
    description,
  });

  app.get(
    '/ontologies',
    {
      schema: {
        ...base(
          'listOntologies',
          'List the ontology library',
          md`
            Every ontology in the library by name, with its newest version (whatever its
            status) and how many versions it has. Retired ontologies are left out unless
            \`retired=include\`.
          `,
        ),
        querystring: ListQuery,
        response: { 200: res('The library.', z.array(OntologySummarySchema)) },
      },
    },
    async (req) => {
      const query = ListQuery.safeParse(req.query ?? {});
      return app.deps.ontologies.list({
        retired: query.success && query.data.retired === 'include',
      });
    },
  );

  app.post(
    '/ontologies',
    {
      preHandler: adminOnly,
      schema: {
        ...base(
          'importOntology',
          'Import an ontology file',
          md`
            **Admin token required.** Stores the file and queues its import as the next
            version of the ontology \`id\` (a new ontology needs \`label\`). The worker parses
            it (Turtle, RDF/XML, JSON-LD, N-Triples or N3, judged by the file name) and indexes
            its classes, properties, SKOS concepts and SHACL shapes; the version's \`status\`
            moves from \`queued\` to \`ready\` or \`failed\`. The same file twice under one id
            is refused.
          `,
        ),
        'x-admin': true,
        consumes: ['multipart/form-data'],
        body: multipart(
          {
            id: { type: 'string', description: 'Ontology id (new or existing), e.g. `idmp-o`.' },
            label: { type: 'string', description: 'Name; required for a new ontology.' },
            description: { type: 'string', description: 'Optional description (new ontologies).' },
            tags: { type: 'string', description: 'Comma-separated tags, e.g. `industry:pharma`.' },
            localOnly: {
              type: 'string',
              enum: ['true', 'false'],
              description: '`true`: its content is never sent to external models.',
            },
          },
          ['id'],
          `The ontology file (${ONTOLOGY_ACCEPT}). Send it last.`,
        ),
        response: {
          202: res('The queued version.', OntologyVersionViewSchema),
          400: error('A missing or invalid field, or an empty file.'),
          403: ADMINS_ONLY,
          409: error('The same file is already a version of this ontology.'),
          413: error('The file is over the upload limit.'),
          415: error('Not a supported RDF format.'),
        },
      },
    },
    async (req, reply) => {
      const { store, buckets, ontologies } = app.deps;
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'file part is required' });
      const id = (multipartField(file, 'id') ?? '').trim();
      if (!ONTOLOGY_ID_RE.test(id)) return reply.code(400).send({ error: ID_RULE });
      const format = ontologyFormat(file.filename);
      if (!format) {
        return reply
          .code(415)
          .send({ error: `file is not a supported RDF format (${ONTOLOGY_ACCEPT})` });
      }
      const label = (multipartField(file, 'label') ?? '').trim();
      const tags = parseTags(multipartField(file, 'tags'));
      if ('error' in tags) return reply.code(400).send({ error: tags.error });
      const existing = await ontologies.get(id);
      if (!existing && !label) return reply.code(400).send({ error: NAME_REQUIRED });
      const body = await file.toBuffer(); // a RequestFileTooLargeError (413) past the limit
      if (body.length === 0) return reply.code(400).send({ error: 'file is empty' });
      const sha256 = createHash('sha256').update(body).digest('hex');
      const sourceKey = ontologySourceKey(id, sha256, format.ext);
      await store.put(buckets.runs, sourceKey, body, format.mediaType);
      const result = await ontologies.createVersion({
        ontologyId: id,
        meta: existing
          ? null
          : {
              label,
              description: (multipartField(file, 'description') ?? '').trim(),
              tags: tags.tags,
              localOnly: multipartField(file, 'localOnly') === 'true',
            },
        fileName: file.filename,
        mediaType: format.mediaType,
        sourceKey,
        sha256,
        bytes: body.length,
        by: by(req),
      });
      if (!result.ok) {
        if (result.reason === 'duplicate') {
          // The stored object is the existing version's file (same bytes, same key).
          return reply
            .code(409)
            .send({ error: `this file is already version ${result.version} of ${id}` });
        }
        await store.delete(buckets.runs, sourceKey);
        return reply.code(400).send({ error: NAME_REQUIRED });
      }
      req.log.info(
        { ontology: id, version: result.version.version, by: by(req) },
        'ontology imported',
      );
      return reply.code(202).send(result.version);
    },
  );

  app.get(
    '/ontologies/:id',
    {
      schema: {
        ...base(
          'getOntology',
          'One ontology with its versions',
          md`
            The ontology's metadata and every version, newest first, with each version's
            status, counts and the \`owl:imports\` it names (listed, not resolved).
          `,
        ),
        params: IdParams,
        response: { 200: res('The ontology.', OntologyDetailSchema), 404: NOT_FOUND },
      },
    },
    async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const detail = await app.deps.ontologies.get(id);
      return detail ?? reply.code(404).send({ error: 'ontology not found' });
    },
  );

  app.patch(
    '/ontologies/:id',
    {
      preHandler: adminOnly,
      schema: {
        ...base(
          'updateOntology',
          'Edit an ontology',
          md`
            **Admin token required.** Changes the name, description, tags or the _Local only_
            flag, or retires the ontology (\`retired: true\`): a retired ontology is hidden
            from the library, and everything that pins it keeps working.
          `,
        ),
        'x-admin': true,
        params: IdParams,
        body: OntologyPatchSchema,
        response: {
          200: res('The ontology.', OntologySummarySchema),
          400: error('An invalid body.'),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const patch = OntologyPatchSchema.safeParse(req.body ?? {});
      if (!patch.success) return reply.code(400).send({ error: patch.error.issues });
      const updated = await app.deps.ontologies.update(id, patch.data);
      if (!updated) return reply.code(404).send({ error: 'ontology not found' });
      req.log.info({ ontology: id, by: by(req) }, 'ontology updated');
      return updated;
    },
  );

  app.delete(
    '/ontologies/:id/versions/:version',
    {
      preHandler: adminOnly,
      schema: {
        ...base(
          'deleteOntologyVersion',
          'Delete an ontology version',
          md`
            **Admin token required.** Deletes a version that is \`ready\` or \`failed\`, with
            its indexed terms and files; deleting the last version deletes the ontology. A
            version still being imported cannot be deleted.
          `,
        ),
        'x-admin': true,
        params: VersionParams,
        response: {
          204: noContent('Deleted.'),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error('The version is still being imported.'),
        },
      },
    },
    async (req, reply) => {
      const params = VersionParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'version not found' });
      const { id, version } = params.data;
      const outcome = await app.deps.ontologies.deleteVersion(id, version);
      if (outcome.result === 'missing') {
        return reply.code(404).send({ error: 'version not found' });
      }
      if (outcome.result === 'busy') {
        return reply
          .code(409)
          .send({ error: `version ${version} of ${id} is still being imported` });
      }
      const { store, buckets } = app.deps;
      const ext = ontologyFormat(outcome.fileName)?.ext;
      const keys = [
        ...(ext ? [ontologySourceKey(id, outcome.sha256, ext)] : []),
        ontologyNormalizedKey(id, version),
      ];
      for (const key of keys) {
        try {
          await store.delete(buckets.runs, key);
        } catch (err) {
          req.log.warn({ err, key }, 'ontology file not removed');
        }
      }
      req.log.info({ ontology: id, version, by: by(req) }, 'ontology version deleted');
      return reply.code(204).send();
    },
  );

  app.get(
    '/ontologies/:id/versions/:version/source',
    {
      schema: {
        ...base(
          'downloadOntologySource',
          'Download an ontology file',
          md`
            The file of this version exactly as it was imported, as an attachment named after
            the uploaded file.
          `,
        ),
        params: VersionParams,
        response: { 200: binary('The ontology file.', ...SOURCE_TYPES), 404: NOT_FOUND },
      },
    },
    async (req, reply) => {
      const params = VersionParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'version not found' });
      const { id, version } = params.data;
      const v = (await app.deps.ontologies.get(id))?.versions.find((x) => x.version === version);
      const ext = v ? ontologyFormat(v.fileName)?.ext : undefined;
      const body =
        v && ext
          ? await app.deps.store.get(app.deps.buckets.runs, ontologySourceKey(id, v.sha256, ext))
          : null;
      if (!v || !body) return reply.code(404).send({ error: 'version not found' });
      return reply
        .header('content-type', v.mediaType)
        .header('content-disposition', contentDisposition(v.fileName, 'attachment'))
        .header('x-content-type-options', 'nosniff')
        .send(body);
    },
  );

  const TermDetailQuery = z.object({
    iri: z.string().min(1).max(2000).describe('The term IRI.'),
  });

  app.get(
    '/ontologies/:id/versions/:version/terms',
    {
      schema: {
        ...base(
          'listOntologyTerms',
          'Search and page ontology terms',
          md`
            One page of a version's terms, by label. \`group\` keeps one browser tab
            (\`classes\`, \`properties\`, \`concepts\` for schemes and their concepts, or
            \`shapes\`); \`root=1\` keeps the tops of the hierarchy and \`parent\` one term's
            children (a top concept's parent is its scheme); \`q\` searches labels, synonyms
            and IRIs, exact and prefix matches first. At most 500 per page.
          `,
        ),
        params: VersionParams,
        querystring: TermQuerySchema,
        response: {
          200: res('One page of terms.', TermPageSchema),
          400: error('An invalid query.'),
          404: NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      const params = VersionParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'version not found' });
      const query = TermQuerySchema.safeParse(req.query ?? {});
      if (!query.success) return reply.code(400).send({ error: query.error.issues });
      const { group, q, parent, root, offset, limit } = query.data;
      const page = await app.deps.ontologies.terms(params.data.id, params.data.version, {
        ...(group ? { group } : {}),
        ...(q ? { q } : {}),
        ...(parent ? { parent } : {}),
        root: root !== undefined,
        offset,
        limit,
      });
      return page ?? reply.code(404).send({ error: 'version not found' });
    },
  );

  app.get(
    '/ontologies/:id/versions/:version/term',
    {
      schema: {
        ...base(
          'getOntologyTerm',
          'Describe one ontology term',
          md`
            A term with its neighbours in this version: parents and children, the classes a
            property's domain and range name, the properties whose domain or range is this
            class, a scheme's concepts and the SHACL shapes targeting it (each list at most
            200).
          `,
        ),
        params: VersionParams,
        querystring: TermDetailQuery,
        response: {
          200: res('The term.', TermDetailSchema),
          400: error('`iri` is missing.'),
          404: error('No such version or term.'),
        },
      },
    },
    async (req, reply) => {
      const params = VersionParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'version not found' });
      const query = TermDetailQuery.safeParse(req.query ?? {});
      if (!query.success) return reply.code(400).send({ error: 'iri is required' });
      const { id, version } = params.data;
      const term = await app.deps.ontologies.term(id, version, query.data.iri);
      return term ?? reply.code(404).send({ error: 'term not found' });
    },
  );
}
