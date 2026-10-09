import { createHash, randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { inboxKey } from '@ih/shared';

const PDF_MAGIC = Buffer.from('%PDF-');

/**
 * POST /api/documents (multipart/form-data)
 *   fields (must precede the file part): specId, specVersion?, model?
 *   file: the PDF
 * Stores the PDF in the inbox bucket and enqueues a job.
 */
export const documentRoutes: FastifyPluginAsync = async (app) => {
  app.post('/documents', async (req, reply) => {
    const { repo, store, specs, buckets } = app.deps;

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'file part is required' });

    const field = (name: string): string | undefined => {
      const f = file.fields[name];
      const one = Array.isArray(f) ? f[0] : f;
      return one && one.type === 'field' ? String(one.value) : undefined;
    };

    const specId = field('specId');
    if (!specId) return reply.code(400).send({ error: 'specId field is required' });
    const versionField = field('specVersion');
    const spec = specs.get(specId, versionField ? Number(versionField) : undefined);
    if (!spec) return reply.code(400).send({ error: `unknown spec ${specId}` });

    const model = field('model') || null;
    if (model) {
      const known = (await repo.listModels()).some((m) => m.enabled && m.ref === model);
      if (!known) return reply.code(400).send({ error: `unknown or disabled model ${model}` });
    }

    const body = await file.toBuffer(); // throws RequestFileTooLargeError (413) past the limit
    if (!body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      return reply.code(415).send({ error: 'file is not a PDF' });
    }

    const documentId = randomUUID();
    const key = inboxKey(spec.id, spec.version, documentId);
    await store.put(buckets.inbox, key, body, 'application/pdf');

    const job = await repo.createDocumentAndJob(
      {
        id: documentId,
        filename: file.filename,
        sha256: createHash('sha256').update(body).digest('hex'),
        sizeBytes: body.length,
        specId: spec.id,
        specVersion: spec.version,
        bucket: buckets.inbox,
        objectKey: key,
      },
      model,
    );
    return reply.code(201).send(job);
  });
};
