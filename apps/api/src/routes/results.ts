import type { FastifyPluginAsync } from 'fastify';
import {
  JobSummarySchema,
  PublishedDocumentSchema,
  ResultDetailSchema,
  ResultSummarySchema,
  type DocumentError,
  type PublishedDocument,
  type ResultDefinition,
  type ResultDetail,
} from '@ih/shared';
import { zipSync } from 'fflate';
import { z } from 'zod';
import { binary, error, md, res } from '../openapi/zod.js';
import { contentDisposition } from './jobs.js';
import { storeFor } from '../storage/stage.js';
import { resolveDefinition } from '../templates/definitions.js';

const UUID = z.string().uuid();
const ResultParams = z.object({ jobId: z.string().uuid().describe('The job id.') });
const NO_RESULT = error('`result not found`: no published, non-test job with this id.');

const ListQuery = z.object({
  templateId: z.string().min(1).optional().describe('Only results of this document type.'),
  limit: z.coerce.number().int().min(1).max(200).default(50).describe('At most 200.'),
  before: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("The next page: the last row's `publishedAt`."),
  beforeId: z.string().uuid().optional().describe("With `before`: the last row's `jobId`."),
  /** File name substring (case-insensitive); blank = no filter. */
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((s) => (s ? s : undefined)),
});

/** Published results: what each document delivered to the final target. */
export const resultRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/results',
    {
      schema: {
        tags: ['Results'],
        operationId: 'listResults',
        summary: 'List published results',
        description: md`
          Jobs that delivered outputs to the final target, newest publish first. Test runs are
          never listed. \`q\` filters by file name (case-insensitive substring). Page with
          \`before\` and \`beforeId\` set to the last row's \`publishedAt\` and \`jobId\`.
        `,
        querystring: ListQuery,
        response: {
          200: res('The results.', z.array(ResultSummarySchema)),
          400: error(
            'The invalid query fields, e.g. `limit: Number must be less than or equal to 200`.',
          ),
        },
      },
    },
    async (req, reply) => {
      const query = ListQuery.safeParse(req.query);
      if (!query.success) {
        const error = query.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return reply.code(400).send({ error });
      }
      return app.deps.repo.listPublished(query.data);
    },
  );
  app.get<{ Params: { jobId: string } }>(
    '/results/:jobId',
    {
      schema: {
        tags: ['Results'],
        operationId: 'getResult',
        summary: 'Get a published result',
        description: md`
          One published result: the job, where it was delivered (\`target\` bucket and prefix),
          its published outputs, and for template jobs the published document read back from the
          target with the definition of its fields and tables. If the document cannot be read,
          \`document\` is null and \`documentError\` says why; the rest is still returned.
        `,
        params: ResultParams,
        response: { 200: res('The result.', ResultDetailSchema), 404: NO_RESULT },
      },
    },
    async (req, reply) => {
      if (!UUID.safeParse(req.params.jobId).success) {
        return reply.code(404).send({ error: 'result not found' });
      }
      const found = await app.deps.repo.getJob(req.params.jobId);
      const outputs = found?.outputs.filter((o) => o.stage === 'published') ?? [];
      if (!found || found.test || outputs.length === 0) {
        return reply.code(404).send({ error: 'result not found' });
      }
      // Strip `outputs` (all stages) from the job: the schema drops unknown keys.
      const job = JobSummarySchema.parse(found);

      const resolved = await resolveDefinition(app.deps, job.specId, job.specVersion);
      const definition: ResultDefinition = !resolved?.ok
        ? { kind: 'unknown' }
        : resolved.definition.kind === 'template'
          ? {
              kind: 'template',
              fields: resolved.definition.template.outputs.fields,
              tables: resolved.definition.template.outputs.tables,
            }
          : { kind: 'spec' };

      let document: PublishedDocument | null = null;
      let documentError: DocumentError | null = null;
      const docOutput = outputs.find((o) => o.outputId === 'document' && o.format === 'json');
      if (docOutput && definition.kind !== 'spec') {
        let body: Buffer | null = null;
        try {
          body = await storeFor(app.deps, 'published').get(docOutput.bucket, docOutput.key);
          if (!body) documentError = 'missing from target';
        } catch (err) {
          req.log.warn({ err, bucket: docOutput.bucket }, 'published document read failed');
          documentError = 'target storage unavailable';
        }
        if (body) {
          let json: unknown;
          try {
            json = JSON.parse(body.toString('utf8'));
          } catch {
            json = undefined;
          }
          const parsed = PublishedDocumentSchema.safeParse(json);
          if (parsed.success) document = parsed.data;
          else documentError = 'invalid document';
        }
      }

      const detail: ResultDetail = {
        job,
        target: app.deps.target,
        publishedAt: (await app.deps.repo.getPublishedAt(job.id)) ?? job.updatedAt,
        outputs,
        document,
        documentError,
        definition,
      };
      return detail;
    },
  );

  /** Every published output of one result as a single ZIP (`<outputId>.<format>` entries). */
  app.get<{ Params: { jobId: string } }>(
    '/results/:jobId/archive',
    {
      schema: {
        tags: ['Results'],
        operationId: 'downloadResultArchive',
        summary: 'Download every output of a result as a ZIP',
        description: md`
          All published outputs of a result in one ZIP, one \`{outputId}.{format}\` entry each,
          named after the PDF. If any output cannot be read from the target the request fails
          rather than returning a partial archive.
        `,
        params: ResultParams,
        response: {
          200: binary('The ZIP archive.', 'application/zip'),
          404: error('`result not found`, or `output object missing from target`.'),
          502: error('`target storage unavailable`.'),
        },
      },
    },
    async (req, reply) => {
      if (!UUID.safeParse(req.params.jobId).success) {
        return reply.code(404).send({ error: 'result not found' });
      }
      const job = await app.deps.repo.getJob(req.params.jobId);
      const outputs = job?.outputs.filter((o) => o.stage === 'published') ?? [];
      if (!job || job.test || outputs.length === 0) {
        return reply.code(404).send({ error: 'result not found' });
      }
      const entries: Record<string, Uint8Array> = {};
      for (const o of outputs) {
        let body: Buffer | null;
        try {
          body = await storeFor(app.deps, 'published').get(o.bucket, o.key);
        } catch (err) {
          req.log.warn({ err, bucket: o.bucket }, 'output read failed');
          return reply.code(502).send({ error: 'target storage unavailable' });
        }
        // A partial archive would look complete: fail instead.
        if (!body) return reply.code(404).send({ error: 'output object missing from target' });
        entries[`${o.outputId}.${o.format}`] = new Uint8Array(body);
      }
      const name = `${job.filename.replace(/\.(pdf|docx)$/i, '')}.zip`;
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', contentDisposition(name, 'attachment'))
        .header('x-content-type-options', 'nosniff')
        .send(Buffer.from(zipSync(entries)));
    },
  );
};
