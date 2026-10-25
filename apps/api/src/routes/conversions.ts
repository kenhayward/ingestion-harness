import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  BatchDetailSchema,
  BatchSchema,
  BatchSummarySchema,
  ConversionTargetSchema,
  CreateBatchSchema,
  decompositionSourceKey,
  DOCX_MIME,
  ItemSchema,
} from '@ih/shared';
import { z } from 'zod';
import { creatorOf } from '../access/routes.js';
import { batchCreator } from '../conversions/repo.js';
import { ErrorBody, error, md, multipart, noContent, res } from '../openapi/zod.js';
import { checkSource, multipartField, TRACKED_CHANGES } from '../uploads.js';

/** What an upload that isn't a Word document gets: PDFs come with decomposition phase 5. */
export const NOT_A_WORD_DOCUMENT = 'file is not a Word document (.docx)';
const NO_DOCUMENTS = 'the target takes no documents';
const NOT_OPEN = 'the batch is not open: it was started or discarded';
/** The most batches `GET /api/conversions/batches` lists. */
const LISTED_BATCHES = 100;
const MAX_SOURCE_KEY = 1024;

const UUID = z.string().uuid();
const BatchParams = z.object({ id: z.string().uuid().describe('The batch id.') });
const ItemParams = z.object({ id: z.string().uuid().describe('The item id.') });
const NOT_FOUND = error('No such batch.');
const CodedError = <C extends string>(description: string, code: C) =>
  res(description, ErrorBody.extend({ code: z.literal(code) }));

/** Whether the target exists and its sink takes decomposed documents (R2). */
async function takesDocuments(app: FastifyInstance, targetId: string): Promise<boolean> {
  const target = await app.deps.targets.get(targetId);
  if (!target) return false;
  const sinks = app.deps.sinks!;
  await sinks.refresh(app.deps.bridge);
  return Boolean(sinks.get(target.sinkId)?.capabilities.decomposedDocuments);
}

/**
 * Decomposition batches (phase 3): the Conversion tab uploads Word files, or a folder, one file
 * per request, and starts the batch, which queues one `decompose` job per file. Operators,
 * designers and admins may all convert (every route is in `OPERATOR_CALLS`).
 */
export const conversionRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/conversions/targets',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'listConversionTargets',
        summary: 'List the targets that take documents',
        description: md`
          The publishing targets whose sink takes decomposed documents, by label: what a batch
          may deliver to. Each has its id, its label and its sink's name.
        `,
        response: {
          200: res('The targets.', z.object({ targets: z.array(ConversionTargetSchema) })),
        },
      },
    },
    async () => {
      const sinks = app.deps.sinks!;
      const views = (await app.deps.targets.list()).filter((v) => v.kind === 'sink');
      if (views.length) await sinks.refresh(app.deps.bridge);
      const targets = views.flatMap((v) => {
        const sink = sinks.get(v.sinkId);
        return sink?.capabilities.decomposedDocuments
          ? [{ id: v.id, label: v.label, sinkName: sink.name }]
          : [];
      });
      targets.sort((a, b) => a.label.localeCompare(b.label));
      return { targets };
    },
  );

  app.post(
    '/conversions/batches',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'createConversionBatch',
        summary: 'Start a batch of documents to convert',
        description: md`
          An open batch for one target that takes documents (\`GET /api/conversions/targets\`).
          Upload its files with \`POST /api/conversions/batches/{id}/items\`, then start it.
          \`force\` makes every item an explicit update: an already loaded document is updated,
          and a duplicate is created (the target's version check still applies).
        `,
        body: CreateBatchSchema,
        response: {
          201: res('The open batch.', BatchSchema),
          400: error('The body is not `{ targetId, force? }`.'),
          422: CodedError(
            'No such target, or its sink takes no documents.',
            'target_takes_no_documents',
          ),
        },
      },
    },
    async (req, reply) => {
      const body = CreateBatchSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if (!(await takesDocuments(app, body.data.targetId))) {
        return reply.code(422).send({ error: NO_DOCUMENTS, code: 'target_takes_no_documents' });
      }
      const batch = await app.deps.repo.createBatch({
        targetId: body.data.targetId,
        force: body.data.force ?? false,
        createdBy: batchCreator(creatorOf(req)),
      });
      return reply.code(201).send(batch);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/conversions/batches/:id/items',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'uploadConversionItem',
        summary: 'Upload one file to an open batch',
        consumes: ['multipart/form-data'],
        description: md`
          One Word document (\`.docx\`) per request, so a large folder never meets the upload
          limit in one go. \`sourceKey\` names the document: the file's path in its folder, or
          its name. It must be new in the batch: the same source key twice is refused (409).
          Send it **before** the file part.

          The file's bytes decide what it is, never its name. A file that isn't a Word document
          (a PDF, a \`.doc\`, a damaged file) is refused (415) and one with tracked changes
          (422); the batch stays open for the others.
        `,
        params: BatchParams,
        body: multipart(
          {
            sourceKey: {
              type: 'string',
              description: "The file's path in its folder, or its name.",
            },
          },
          ['sourceKey'],
          'The Word document. Send it last.',
        ),
        response: {
          201: res('The item.', ItemSchema),
          400: error('A missing `file` part or `sourceKey`.'),
          404: NOT_FOUND,
          406: error('The request is not `multipart/form-data`.'),
          409: error('The batch is not open, or the source key is already in it.'),
          413: error('The file is larger than the upload limit.'),
          415: error(`\`${NOT_A_WORD_DOCUMENT}\`.`),
          422: error(
            `\`${TRACKED_CHANGES}\`, or \`the Word document is too large to check (over 64 MiB ` +
              'unpacked)`.',
          ),
        },
      },
    },
    async (req, reply) => {
      const { repo, store, buckets, maxUploadBytes } = app.deps;
      const batchId = req.params.id;
      const batch = UUID.safeParse(batchId).success ? await repo.getBatch(batchId) : null;
      if (!batch) return reply.code(404).send({ error: 'not found' });
      if (batch.state !== 'open') return reply.code(409).send({ error: NOT_OPEN });

      const file = await req.file({ limits: { files: 1, fileSize: maxUploadBytes } });
      if (!file) return reply.code(400).send({ error: 'file part is required' });
      const sourceKey = multipartField(file, 'sourceKey');
      if (!sourceKey || sourceKey.length > MAX_SOURCE_KEY) {
        return reply
          .code(400)
          .send({ error: `sourceKey field is required (at most ${MAX_SOURCE_KEY} characters)` });
      }
      const body = await file.toBuffer(); // throws RequestFileTooLargeError (413) past the limit
      const source = checkSource(body);
      if (!source.ok && source.code === 422) return reply.code(422).send({ error: source.error });
      if (!source.ok || source.kind !== 'docx') {
        return reply.code(415).send({ error: NOT_A_WORD_DOCUMENT });
      }

      const id = randomUUID();
      const objectKey = decompositionSourceKey(batchId, id, 'docx');
      await store.put(buckets.runs, objectKey, body, DOCX_MIME);
      const added = await repo.addItem({
        id,
        batchId,
        sourceKey,
        filename: file.filename,
        contentSha256: createHash('sha256').update(body).digest('hex'),
        sizeBytes: body.length,
        objectKey,
      });
      if (added.ok) return reply.code(201).send(added.item);
      await store.delete(buckets.runs, objectKey);
      if (added.reason === 'missing') return reply.code(404).send({ error: 'not found' });
      if (added.reason === 'not_open') return reply.code(409).send({ error: NOT_OPEN });
      return reply.code(409).send({ error: `${sourceKey} is already in the batch` });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/conversions/batches/:id/start',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'startConversionBatch',
        summary: 'Start converting a batch',
        description: md`
          Queues one \`decompose\` job per item, at the priority of an upload, and closes the
          batch to more files. Each job decomposes its file and delivers it to the batch's
          target; follow the items with \`GET /api/conversions/batches/{id}\`. The batch carries
          on without the page that started it.
        `,
        params: BatchParams,
        response: {
          200: res('The started batch.', BatchSchema),
          404: NOT_FOUND,
          409: error('The batch was started or discarded already.'),
          422: CodedError('The batch has no items.', 'empty_batch'),
        },
      },
    },
    async (req, reply) => {
      if (!UUID.safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'not found' });
      }
      const started = await app.deps.repo.startBatch(req.params.id, creatorOf(req));
      if (started.ok) return started.batch;
      if (started.reason === 'missing') return reply.code(404).send({ error: 'not found' });
      if (started.reason === 'not_open') return reply.code(409).send({ error: NOT_OPEN });
      return reply.code(422).send({ error: 'the batch has no items', code: 'empty_batch' });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/conversions/batches/:id',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'discardConversionBatch',
        summary: 'Discard an open batch',
        description: md`
          Throws away a batch that was never started, with its uploaded files. A started batch
          has jobs and is kept.
        `,
        params: BatchParams,
        response: {
          204: noContent('Discarded.'),
          404: NOT_FOUND,
          409: error('The batch was started, or discarded already.'),
        },
      },
    },
    async (req, reply) => {
      if (!UUID.safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'not found' });
      }
      const { repo, store, buckets } = app.deps;
      const discarded = await repo.discardBatch(req.params.id);
      if (!discarded.ok) {
        if (discarded.reason === 'missing') return reply.code(404).send({ error: 'not found' });
        return reply.code(409).send({ error: NOT_OPEN });
      }
      for (const key of discarded.objectKeys) await store.delete(buckets.runs, key);
      return reply.code(204).send();
    },
  );

  app.get(
    '/conversions/batches',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'listConversionBatches',
        summary: 'List batches',
        description: md`
          The newest ${LISTED_BATCHES} batches, open or started (discarded ones are left out),
          newest first, each with its number of items and how many have each outcome.
        `,
        response: {
          200: res('The batches.', z.object({ batches: z.array(BatchSummarySchema) })),
        },
      },
    },
    async () => ({ batches: await app.deps.repo.listBatches(LISTED_BATCHES) }),
  );

  app.get<{ Params: { id: string } }>(
    '/conversions/batches/:id',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'getConversionBatch',
        summary: 'Get a batch and its items',
        description: md`
          The batch and its items in upload order: each item's outcome and detail, its link in
          the target once delivered, and whether its report is ready (\`reportKey\`).
        `,
        params: BatchParams,
        response: { 200: res('The batch.', BatchDetailSchema), 404: NOT_FOUND },
      },
    },
    async (req, reply) => {
      const { repo } = app.deps;
      const batch = UUID.safeParse(req.params.id).success
        ? await repo.getBatch(req.params.id)
        : null;
      if (!batch) return reply.code(404).send({ error: 'not found' });
      return { batch, items: await repo.listItems(batch.id) };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/conversions/items/:id/report',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'getConversionReport',
        summary: "Get an item's decomposition report",
        description: md`
          What decomposing the item's file noticed (the report's flags), as the worker stored it
          beside the file. Not found until the item has been decomposed.
        `,
        params: ItemParams,
        response: {
          200: res('The report.', z.record(z.string(), z.unknown())),
          404: error('No such item, or no report yet.'),
        },
      },
    },
    async (req, reply) => {
      const { repo, store, buckets } = app.deps;
      const item = UUID.safeParse(req.params.id).success ? await repo.getItem(req.params.id) : null;
      const body = item?.reportKey ? await store.get(buckets.runs, item.reportKey) : null;
      if (!body) return reply.code(404).send({ error: 'no report' });
      return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    },
  );
};
