import type { FastifyPluginAsync } from 'fastify';
import {
  JobSummarySchema,
  PublishedDocumentSchema,
  type DocumentError,
  type PublishedDocument,
  type ResultDefinition,
  type ResultDetail,
} from '@ih/shared';
import { z } from 'zod';
import { storeFor } from '../storage/stage.js';
import { resolveDefinition } from '../templates/definitions.js';

const UUID = z.string().uuid();

const ListQuery = z.object({
  templateId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime({ offset: true }).optional(),
});

/** Published results: what each document delivered to the final target. */
export const resultRoutes: FastifyPluginAsync = async (app) => {
  app.get('/results', async (req, reply) => {
    const query = ListQuery.safeParse(req.query);
    if (!query.success) {
      const error = query.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.code(400).send({ error });
    }
    return app.deps.repo.listPublished(query.data);
  });
  app.get<{ Params: { jobId: string } }>('/results/:jobId', async (req, reply) => {
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
      outputs,
      document,
      documentError,
      definition,
    };
    return detail;
  });
};
