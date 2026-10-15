import { createHash, randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { inboxKey, JobSummarySchema, modelRefProblem } from '@ih/shared';
import { error, md, multipart, res } from '../openapi/zod.js';
import {
  draftOutputsSnapshot,
  resolveDefinition,
  runnableModels,
} from '../templates/definitions.js';
import { retiredProblem, RETIRED_DOC } from '../templates/retirement.js';
import { checkSource, multipartField, NOT_A_SOURCE, TRACKED_CHANGES } from '../uploads.js';
import { creatorOf } from '../access/routes.js';

/**
 * POST /api/documents (multipart/form-data)
 *   fields (must precede the file part): specId, specVersion?, model?, test?
 *   (draft recipe versions can only be uploaded as test runs: test=true)
 *   file: the PDF or Word document (.docx)
 * Stores the file in the inbox bucket and enqueues a job.
 */
export const documentRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/documents',
    {
      schema: {
        tags: ['Documents'],
        operationId: 'uploadDocument',
        summary: 'Upload a PDF or Word document to process',
        consumes: ['multipart/form-data'],
        description: md`
          Stores the file in the inbox bucket, records the document and queues a \`process\`
          job for it. The worker picks the job up; poll \`GET /api/jobs/{id}\` for its status.
          A Word document (\`.docx\`) is converted to PDF by the worker first, and then
          processed like a PDF (pages come from the converted PDF).

          Send the text fields **before** the file part: the upload is read as it streams in, so
          fields after the file are not seen.

          - \`specId\` names the document type; \`specVersion\` picks a version (default: the
            latest published one, or the newest spec file).
          - A draft recipe version can only be uploaded as a test run (\`test=true\`). Test
            runs can be reviewed but are never delivered to the target.
          - \`model\` overrides the document type's model for every step: a model choice's id
            from \`GET /api/models/choices\` (\`default\` is the default choice), or an
            offered \`endpoint/model\` ref from \`GET /api/models\`.
          - A retired document type is refused (409) until an admin unretires it.

          The file's bytes decide what it is, never its name: a PDF (starting \`%PDF-\`) or a
          \`.docx\` (a Word document; not \`.docm\`, \`.dotx\` or \`.doc\`) without tracked
          changes. It must fit the upload limit (\`MAX_UPLOAD_MB\`). The job's
          \`contentType\` says which it is.
        `,
        body: multipart(
          {
            specId: { type: 'string', description: 'The document type id.' },
            specVersion: {
              type: 'string',
              description: 'A version number. Default: the latest published version.',
            },
            model: {
              type: 'string',
              description:
                "A model choice's id (or an offered model ref) to use instead of the document type's models.",
            },
            test: {
              type: 'string',
              enum: ['true', 'false'],
              description: '`true` for a test run (required for a draft version).',
            },
          },
          ['specId'],
        ),
        response: {
          201: res('The queued job.', JobSummarySchema),
          400: error(
            'A missing `file` part or `specId`, an unknown document type or version, a draft ' +
              'without `test=true`, or a model that is no choice or is not offered.',
          ),
          406: error('The request is not `multipart/form-data`.'),
          413: error('The file is larger than the upload limit.'),
          409: error(RETIRED_DOC + '.'),
          415: error(`\`${NOT_A_SOURCE}\`.`),
          422: error(
            `\`${TRACKED_CHANGES}\`, or \`the Word document is too large to check (over 64 MiB ` +
              'unpacked)`.',
          ),
        },
      },
    },
    async (req, reply) => {
      const { repo, store, buckets } = app.deps;

      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'file part is required' });

      const specId = multipartField(file, 'specId');
      if (!specId) return reply.code(400).send({ error: 'specId field is required' });
      const versionField = multipartField(file, 'specVersion');
      const test = multipartField(file, 'test') === 'true';
      const resolved = await resolveDefinition(
        app.deps,
        specId,
        versionField ? Number(versionField) : undefined,
      );
      if (!resolved) return reply.code(400).send({ error: `unknown spec ${specId}` });
      if (!resolved.ok) return reply.code(400).send({ error: resolved.error });
      if (resolved.draft && !test) {
        return reply
          .code(400)
          .send({ error: 'draft recipes can only be test-run (set test=true)' });
      }
      const spec = resolved.definition;
      // Before anything is stored or queued: a retired type takes no new work.
      const retired = await retiredProblem(app.deps, spec.id);
      if (retired) return reply.code(409).send({ error: retired });

      const model = multipartField(file, 'model') || null;
      if (model) {
        // A model choice (or an offered `endpoint/model` ref, for API callers; ADR 0010).
        const { offered, aliases } = await runnableModels(app.deps);
        const problem = modelRefProblem(model, offered, aliases);
        if (problem) return reply.code(400).send({ error: problem });
      }

      const body = await file.toBuffer(); // throws RequestFileTooLargeError (413) past the limit
      const source = checkSource(body);
      if (!source.ok) return reply.code(source.code).send({ error: source.error });

      const documentId = randomUUID();
      const key = inboxKey(spec.id, spec.version, documentId, source.ext);
      await store.put(buckets.inbox, key, body, source.contentType);

      // A draft can change after the run: snapshot the outputs it was run against.
      const record = resolved.draft ? await app.deps.templates.get(spec.id, spec.version) : null;
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
        test,
        null,
        record ? draftOutputsSnapshot(record.definition) : null,
        creatorOf(req),
      );
      return reply.code(201).send(job);
    },
  );
};
