import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  AcceptedTargetStateSchema,
  AcceptPreviewSchema,
  AcceptTargetStateSchema,
  BatchDetailSchema,
  BatchSchema,
  BatchSummarySchema,
  ConversionTargetSchema,
  ConversionReviewSchema,
  CreateBatchSchema,
  decompositionHeldPageKey,
  decompositionReportKey,
  decompositionSourceKey,
  DOCX_MIME,
  hasControlCharacter,
  ItemSchema,
  MAX_SOURCE_KEY,
  RejectDecisionSchema,
  RetryItemsSchema,
  ReviewDecisionSchema,
  sourceKeyProblem,
  type Batch,
  type Item,
} from '@ih/shared';
import { z } from 'zod';
import { creatorOf } from '../access/routes.js';
import { acceptPlanOf } from '../conversions/accept.js';
import { deleteHeld, isHeldKey, readHeld } from '../conversions/held.js';
import type { RegisterEntry } from '../repositories/types.js';
import {
  batchCreator,
  isGone,
  RUNNING_OUTCOMES,
  type AddItemResult,
  type Rerun,
  type RerunResult,
} from '../conversions/repo.js';
import { binary, ErrorBody, error, md, multipart, noContent, res } from '../openapi/zod.js';
import { contentDisposition } from './jobs.js';
import { checkSource, CONTENT_TYPES, multipartField, TRACKED_CHANGES } from '../uploads.js';

/** What an upload that is neither a Word document nor a PDF gets (415). */
export const NOT_WORD_OR_PDF = 'Word or PDF files only';
const NOT_AWAITING_REVIEW = 'the item is not awaiting review';
const HELD_GONE = 'the held files are gone from storage';
const NO_DOCUMENTS = 'the target takes no documents';
const NOT_OPEN = 'the batch is not open: it was started or discarded';
/** Why a batch is not open, from its state (the generic reason when it is unknown). */
const notOpen = (batch: Batch | null) =>
  batch?.state === 'started'
    ? 'the batch was already started'
    : batch?.state === 'discarded'
      ? 'the batch was discarded'
      : NOT_OPEN;
/** The most batches `GET /api/conversions/batches` lists. */
const LISTED_BATCHES = 100;
const BAD_FILENAME = 'the file name holds a control character';
const NO_ENTRY = 'the item has no register entry: it was never delivered, or was detached';
const IN_FLIGHT = 'a delivery of this document, or a run of its file, is in flight';
const RERUN_RUNNING = 'a rerun of this item is still running';
const STALE_PREVIEW = 'the document changed since the preview: look at it again';
const NOT_REFUSED =
  'the document is not refused as changed in the target: only a refused document, one whose ' +
  'versions were never recorded, or one gone from the target, is detached';
const NOT_GONE =
  'the document is not gone from the target: only a document the target no longer has, or ' +
  'one still detached that no later run has created again, is loaded as a new document';

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
          One Word document (\`.docx\`) or PDF per request, so a large folder never meets the
          upload limit in one go. \`sourceKey\` names the document: the file's path in its folder, or
          its name. It must be new in the batch: the same source key twice is refused (409).
          Send it **before** the file part. A source key is relative and \`/\`-separated
          (at most ${MAX_SOURCE_KEY} characters; no control characters, backslashes, empty,
          \`.\` or \`..\` parts, or \`/\` at either end) and is stored in its NFC form.
          Another is refused (422 \`bad_source_key\`), as is a file name with a control
          character (422 \`bad_filename\`).

          The file's bytes decide what it is, never its name. A file that is neither a Word
          document nor a PDF (a \`.doc\`, a damaged file) is refused (415) and a Word document
          with tracked changes (422); the batch stays open for the others. A PDF is held for
          review once converted (\`awaiting_review\`).
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
          'The Word document or PDF. Send it last.',
        ),
        response: {
          201: res('The item.', ItemSchema),
          400: error('A missing `file` part (the part must be named `file`) or `sourceKey`.'),
          404: NOT_FOUND,
          406: error('The request is not `multipart/form-data`.'),
          409: error('The batch is not open, or the source key is already in it.'),
          413: error('The file is larger than the upload limit.'),
          415: error(`\`${NOT_WORD_OR_PDF}\`.`),
          422: res(
            `\`${TRACKED_CHANGES}\`, \`the Word document is too large to check (over 64 MiB ` +
              'unpacked)`, a source key the rule refuses (`code: bad_source_key`) or a file ' +
              'name with a control character (`code: bad_filename`).',
            ErrorBody.extend({ code: z.enum(['bad_source_key', 'bad_filename']).optional() }),
          ),
        },
      },
    },
    async (req, reply) => {
      const { repo, store, buckets, maxUploadBytes } = app.deps;
      const batchId = req.params.id;
      const batch = UUID.safeParse(batchId).success ? await repo.getBatch(batchId) : null;
      if (!batch) return reply.code(404).send({ error: 'not found' });
      if (batch.state !== 'open') return reply.code(409).send({ error: notOpen(batch) });

      const file = await req.file({ limits: { files: 1, fileSize: maxUploadBytes } });
      if (!file || file.fieldname !== 'file') {
        return reply.code(400).send({ error: 'file part is required' });
      }
      const sent = multipartField(file, 'sourceKey');
      if (sent === undefined) return reply.code(400).send({ error: 'sourceKey field is required' });
      const problem = sourceKeyProblem(sent);
      if (problem) return reply.code(422).send({ error: problem, code: 'bad_source_key' });
      const sourceKey = sent.normalize('NFC');
      if (hasControlCharacter(file.filename)) {
        return reply.code(422).send({ error: BAD_FILENAME, code: 'bad_filename' });
      }
      const body = await file.toBuffer(); // throws RequestFileTooLargeError (413) past the limit
      const source = checkSource(body);
      if (!source.ok && source.code === 422) return reply.code(422).send({ error: source.error });
      if (!source.ok) return reply.code(415).send({ error: NOT_WORD_OR_PDF });

      const id = randomUUID();
      const objectKey = decompositionSourceKey(batchId, id, source.ext);
      await store.put(buckets.runs, objectKey, body, source.contentType);
      // Whatever happens to the item (refused, or the database fails), no file is left behind.
      let added: AddItemResult;
      try {
        added = await repo.addItem({
          id,
          batchId,
          sourceKey,
          filename: file.filename,
          contentSha256: createHash('sha256').update(body).digest('hex'),
          sizeBytes: body.length,
          objectKey,
        });
      } catch (err) {
        await store.delete(buckets.runs, objectKey);
        throw err;
      }
      if (added.ok) return reply.code(201).send(added.item);
      await store.delete(buckets.runs, objectKey);
      if (added.reason === 'missing') return reply.code(404).send({ error: 'not found' });
      if (added.reason === 'not_open') {
        return reply.code(409).send({ error: notOpen(await repo.getBatch(batchId)) });
      }
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
      if (started.reason === 'not_open') {
        const batch = await app.deps.repo.getBatch(req.params.id);
        return reply.code(409).send({ error: notOpen(batch) });
      }
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
        return reply.code(409).send({ error: notOpen(await repo.getBatch(req.params.id)) });
      }
      // The batch is discarded already: one failed delete must not keep the others.
      const deleted = await Promise.allSettled(
        discarded.objectKeys.map((key) => store.delete(buckets.runs, key)),
      );
      deleted.forEach((d, i) => {
        if (d.status === 'rejected') {
          const key = discarded.objectKeys[i];
          req.log.warn({ err: d.reason, key }, 'a discarded batch file was not deleted');
        }
      });
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
          the target once delivered, whether its report is ready (\`reportKey\`), and, for a
          document refused as changed in the target, whether it has since been detached or its
          target state accepted (\`resolution\`, read from its register entry).
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
      // Only the item's own report key (as the worker names it) is ever read.
      const key = item?.reportKey;
      const own = item !== null && key === decompositionReportKey(item.batchId, item.id);
      const body = own ? await store.get(buckets.runs, key) : null;
      if (!item || !body) return reply.code(404).send({ error: 'no report' });
      try {
        const report: unknown = JSON.parse(body.toString('utf8'));
        if (report && typeof report === 'object' && !Array.isArray(report)) return report;
      } catch {
        // Corrupt: answered as no report, below.
      }
      req.log.warn({ item: item.id }, 'a conversion report is not a JSON object');
      return reply.code(404).send({ error: 'no report' });
    },
  );

  // --- Row actions (spec §8): force-load, redeliver, detach, accept the target's state ---------

  /** The item the path names, or null (not a uuid, or no such item). */
  const findItem = async (id: string) =>
    UUID.safeParse(id).success ? app.deps.repo.getItem(id) : null;

  /** Why an item can't be rerun yet, or null: its batch started and its outcome decided. */
  const notFinished = (item: Item, batch: Batch | null) =>
    batch?.state !== 'started'
      ? 'the item was never started'
      : RUNNING_OUTCOMES.includes(item.outcome)
        ? 'the item is still running'
        : null;

  /**
   * The item's register entry: the one its delivery settled, or the worker decided about. A
   * detached one (a tombstone) is none.
   */
  const entryOf = async (item: Item) => {
    const entry = item.registerEntryId
      ? await app.deps.repo.registerEntry(item.registerEntryId)
      : null;
    return entry?.state === 'detached' ? null : entry;
  };

  /** The targets on an entry's tenant (its sink and instance): register entries are per tenant. */
  const tenantTargets = async (entry: RegisterEntry) =>
    (await app.deps.targets.list())
      .filter((t) => t.sinkId === entry.sinkId && t.instanceId === entry.instanceId)
      .map((t) => t.id);

  /** A new batch of one, forced and started, rerunning `of` with `source` (R6). */
  const rerun = (
    req: FastifyRequest,
    ids: { batchId: string; itemId: string },
    of: Item,
    batch: Batch,
    source: Rerun['source'],
  ) =>
    app.deps.repo.rerunItem({
      ...ids,
      of,
      targetId: batch.targetId,
      createdBy: batchCreator(creatorOf(req)),
      by: creatorOf(req),
      source,
    });

  /** A rerun's answer: the new batch of one, or 409 while an earlier rerun is unfinished. */
  const rerunReply = (reply: FastifyReply, done: RerunResult) =>
    done.ok
      ? reply.code(201).send({ batch: done.batch, items: [done.item] })
      : reply.code(409).send({ error: RERUN_RUNNING, code: 'not_finished' });

  /** The stored source an item delivered, for a rerun that sends no replacement. */
  const storedSource = (item: Item): Rerun['source'] => ({
    filename: item.filename,
    contentSha256: item.contentSha256,
    sizeBytes: item.sizeBytes,
    objectKey: item.objectKey,
  });

  const RerunResponses = {
    201: res('The new batch of one, started, and its item.', BatchDetailSchema),
    404: error('No such item.'),
    409: CodedError(
      'The item never started, is still running, or a rerun of it is still running (a repeated ' +
        'request).',
      'not_finished',
    ),
    422: CodedError("The batch's target no longer takes documents.", 'target_takes_no_documents'),
  };

  app.post<{ Params: { id: string } }>(
    '/conversions/batches/:id/retry',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'retryConversionItems',
        summary: "Re-run a batch's failed documents",
        description: md`
          Runs the batch's failed documents named in \`itemIds\` again, from the files uploaded
          with it, as one new batch that starts at once (the Conversion tab's _Re-run failed_).
          Each new item keeps its document's source key and names the item it re-runs
          (\`redeliverOf\`); nothing is uploaded again. \`force\` delivers them as an explicit
          update (absent: as the batch was started). Only items of this batch whose outcome is
          \`failed\`; refused while an earlier re-run of any of them is unfinished, so a
          repeated request makes one batch, and once any of them was run again at all (its
          \`rerunIn\` is set): a document is re-run once, and a failed re-run is re-run from its
          own batch. The batch keeps its record.
        `,
        params: BatchParams,
        body: RetryItemsSchema,
        response: {
          201: res('The new batch, started, and its items in the order asked.', BatchDetailSchema),
          400: error('The body is not `{ itemIds, force? }`: one to 1,000 item ids, each once.'),
          404: NOT_FOUND,
          409: res(
            'The batch was never started, or an earlier re-run of one of the items is still ' +
              'running (a repeated request; `not_finished`), or one of the items was already ' +
              'run again (`already_rerun`, naming it).',
            ErrorBody.extend({ code: z.enum(['not_finished', 'already_rerun']) }),
          ),
          422: res(
            'An item is not a failed item of this batch (`not_failed`), or the target no ' +
              'longer takes documents.',
            ErrorBody.extend({ code: z.enum(['not_failed', 'target_takes_no_documents']) }),
          ),
        },
      },
    },
    async (req, reply) => {
      const { repo } = app.deps;
      const batch = UUID.safeParse(req.params.id).success
        ? await repo.getBatch(req.params.id)
        : null;
      if (!batch) return reply.code(404).send({ error: 'not found' });
      const body = RetryItemsSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if (batch.state !== 'started') {
        return reply.code(409).send({ error: 'the batch was never started', code: 'not_finished' });
      }
      const items = new Map((await repo.listItems(batch.id)).map((i) => [i.id, i]));
      const asked = body.data.itemIds.map((id) => items.get(id));
      const notFailed = body.data.itemIds.find((id, n) => asked[n]?.outcome !== 'failed');
      if (notFailed) {
        return reply.code(422).send({
          error: `${notFailed} is not a failed document of this batch`,
          code: 'not_failed',
        });
      }
      if (!(await takesDocuments(app, batch.targetId))) {
        return reply.code(422).send({ error: NO_DOCUMENTS, code: 'target_takes_no_documents' });
      }
      const done = await repo.retryItems({
        batchId: randomUUID(),
        items: (asked as Item[]).map((of) => ({ itemId: randomUUID(), of })),
        targetId: batch.targetId,
        force: body.data.force ?? batch.force,
        createdBy: batchCreator(creatorOf(req)),
        by: creatorOf(req),
      });
      if (!done.ok) {
        const key = items.get(done.itemId)?.sourceKey ?? done.itemId;
        return done.reason === 'running'
          ? reply
              .code(409)
              .send({ error: `a re-run of ${key} is still running`, code: 'not_finished' })
          : reply.code(409).send({ error: `${key} was already re-run`, code: 'already_rerun' });
      }
      return reply.code(201).send({ batch: done.batch, items: done.items });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/conversions/items/:id/source',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'getConversionSource',
        summary: "Download an item's Word or PDF file",
        description: md`
          The Word document (\`.docx\`) or PDF the item converted, as uploaded (or the
          replacement a redeliver sent), as an attachment under its file name, with its own
          content type.
        `,
        params: ItemParams,
        response: {
          200: binary('The file.', DOCX_MIME, CONTENT_TYPES.pdf),
          404: error('No such item, or its file is gone from storage.'),
          502: error('`storage unavailable`.'),
        },
      },
    },
    async (req, reply) => {
      const item = await findItem(req.params.id);
      if (!item) return reply.code(404).send({ error: 'not found' });
      let body: Buffer | null;
      try {
        body = await app.deps.store.get(app.deps.buckets.runs, item.objectKey);
      } catch (err) {
        req.log.warn({ err, item: item.id }, 'a conversion source read failed');
        return reply.code(502).send({ error: 'storage unavailable' });
      }
      if (!body) return reply.code(404).send({ error: 'the file is gone from storage' });
      return reply
        .header('content-type', item.objectKey.endsWith('.pdf') ? CONTENT_TYPES.pdf : DOCX_MIME)
        .header('content-disposition', contentDisposition(item.filename, 'attachment'))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'no-store')
        .send(body);
    },
  );

  // --- Review of a held PDF (spec §14.4, §14.5) -------------------------------------------------

  const NotAwaiting = CodedError('The item is not awaiting review.', 'NOT_AWAITING_REVIEW');
  const notAwaiting = (reply: FastifyReply) =>
    reply.code(409).send({ error: NOT_AWAITING_REVIEW, code: 'NOT_AWAITING_REVIEW' });

  /** The item a review route reads, awaiting review; otherwise the reply already sent (404, 409). */
  const awaitingItem = async (id: string, reply: FastifyReply) => {
    const item = await findItem(id);
    if (!item) {
      reply.code(404).send({ error: 'not found' });
      return null;
    }
    if (item.outcome !== 'awaiting_review') {
      notAwaiting(reply);
      return null;
    }
    return item;
  };

  app.get<{ Params: { id: string } }>(
    '/conversions/items/:id/review',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'getConversionReview',
        summary: 'Get a held PDF to review',
        description: md`
          The decomposed document of a PDF held for review, as it would be delivered, with the
          number of pages, the pages each section and block came from (\`pageMap\`) and the held
          images' types (\`GET /api/conversions/items/{id}/images/{index}\` serves each; the pages
          come from \`GET /api/conversions/items/{id}/pages/{n}\`). Read from the held manifest the
          worker stored. Only while the item is \`awaiting_review\`.
        `,
        params: ItemParams,
        response: {
          200: res('The held document.', ConversionReviewSchema),
          404: error('No such item, or its held files are gone from storage.'),
          409: NotAwaiting,
          502: error('`storage unavailable`, or the held manifest is not readable.'),
        },
      },
    },
    async (req, reply) => {
      const item = await awaitingItem(req.params.id, reply);
      if (!item) return reply;
      let held: Awaited<ReturnType<typeof readHeld>>;
      try {
        held = await readHeld(app.deps.store, app.deps.buckets.runs, item);
      } catch (err) {
        req.log.warn({ err, item: item.id }, 'a held manifest read failed');
        return reply.code(502).send({ error: 'storage unavailable' });
      }
      if (!held.ok && held.reason === 'gone') return reply.code(404).send({ error: HELD_GONE });
      if (!held.ok) {
        req.log.warn({ item: item.id }, 'a held manifest is not a valid manifest');
        return reply.code(502).send({ error: 'the held document is not readable' });
      }
      const { document, pageCount, pageMap, images } = held.manifest;
      return {
        item,
        document,
        pageCount,
        pageMap,
        images: images.map(({ id, contentType }) => ({ id, contentType })),
      };
    },
  );

  app.get<{ Params: { id: string; n: string } }>(
    '/conversions/items/:id/pages/:n',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'getConversionPage',
        summary: 'Get a held PDF page image',
        description: md`
          A JPEG of one page of a PDF held for review, rendered by the worker. Pages are
          numbered from 1. Only while the item is \`awaiting_review\`.
        `,
        params: ItemParams.extend({ n: z.string().describe('The 1-based page number.') }),
        response: {
          200: binary('The page image.', 'image/jpeg'),
          400: error('`page must be a positive integer`.'),
          404: error('No such item, or no such page.'),
          409: NotAwaiting,
          502: error('`storage unavailable`.'),
        },
      },
    },
    async (req, reply) => {
      const page = Number(req.params.n);
      if (!Number.isInteger(page) || page < 1 || page > 5000) {
        return reply.code(400).send({ error: 'page must be a positive integer' });
      }
      const item = await awaitingItem(req.params.id, reply);
      if (!item) return reply;
      let body: Buffer | null;
      try {
        body = await app.deps.store.get(
          app.deps.buckets.runs,
          decompositionHeldPageKey(item.batchId, item.id, page),
        );
      } catch (err) {
        req.log.warn({ err, item: item.id }, 'a held page read failed');
        return reply.code(502).send({ error: 'storage unavailable' });
      }
      if (!body) return reply.code(404).send({ error: 'page not found' });
      return reply
        .header('content-type', 'image/jpeg')
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, max-age=300')
        .send(body);
    },
  );

  app.get<{ Params: { id: string; index: string } }>(
    '/conversions/items/:id/images/:index',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'getConversionImage',
        summary: 'Get a held PDF image',
        description: md`
          One of the images extracted from a PDF held for review, by its position in the review's
          \`images\`, with its own content type. Only while the item is \`awaiting_review\`.
        `,
        params: ItemParams.extend({ index: z.string().describe('The 0-based image position.') }),
        response: {
          200: binary('The image.', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'),
          400: error('`index must be a non-negative integer`.'),
          404: error('No such item, or no such image.'),
          409: NotAwaiting,
          502: error('`storage unavailable`, or the held manifest is not readable.'),
        },
      },
    },
    async (req, reply) => {
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) {
        return reply.code(400).send({ error: 'index must be a non-negative integer' });
      }
      const item = await awaitingItem(req.params.id, reply);
      if (!item) return reply;
      let body: Buffer | null = null;
      let contentType = '';
      try {
        const held = await readHeld(app.deps.store, app.deps.buckets.runs, item);
        if (!held.ok && held.reason === 'bad') {
          return reply.code(502).send({ error: 'the held document is not readable' });
        }
        const image = held.ok ? held.manifest.images[index] : undefined;
        // Only the item's own held files are ever read, whatever the manifest names.
        if (image && isHeldKey(item, image.key)) {
          contentType = image.contentType;
          body = await app.deps.store.get(app.deps.buckets.runs, image.key);
        }
      } catch (err) {
        req.log.warn({ err, item: item.id }, 'a held image read failed');
        return reply.code(502).send({ error: 'storage unavailable' });
      }
      if (!body) return reply.code(404).send({ error: 'image not found' });
      return reply
        .header('content-type', contentType)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, max-age=300')
        .send(body);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/conversions/items/:id/approve',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'approveConversionItem',
        summary: 'Approve a held PDF',
        description: md`
          Records who approved the held document, and when, with an optional \`note\`, and queues
          its delivery: the worker delivers exactly the held document (it does not read the PDF
          again) as the user who started the batch. The item is \`queued\` again, then ends like
          any delivery. Only while the item is \`awaiting_review\`, so two reviewers cannot both
          decide.
        `,
        params: ItemParams,
        body: ReviewDecisionSchema,
        response: {
          202: res('Queued; the delivery job.', z.object({ jobId: z.string().uuid() })),
          400: error('The body is not `{ note? }`.'),
          404: error('No such item.'),
          409: NotAwaiting,
        },
      },
    },
    async (req, reply) => {
      const body = ReviewDecisionSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if (!UUID.safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'not found' });
      }
      const done = await app.deps.repo.approveItem({
        id: req.params.id,
        by: creatorOf(req),
        note: body.data.note ?? null,
      });
      if (done.kind === 'approved') return reply.code(202).send({ jobId: done.jobId });
      if (done.kind === 'not_found') return reply.code(404).send({ error: 'not found' });
      return notAwaiting(reply);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/conversions/items/:id/reject',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'rejectConversionItem',
        summary: 'Reject a held PDF',
        description: md`
          Records who rejected the held document, and when, with the \`note\` saying why (required),
          sets the item \`rejected\` (final) and deletes the held files. A forced run of the row
          decomposes the PDF again, and a redelivery takes a Word file or a PDF. Only while the item
          is \`awaiting_review\`.
        `,
        params: ItemParams,
        body: RejectDecisionSchema,
        response: {
          200: res('The rejected item.', ItemSchema),
          400: error('The body is not `{ note }`: the note is required.'),
          404: error('No such item.'),
          409: NotAwaiting,
        },
      },
    },
    async (req, reply) => {
      const body = RejectDecisionSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if (!UUID.safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'not found' });
      }
      const { repo, store, buckets } = app.deps;
      const done = await repo.rejectItem({
        id: req.params.id,
        by: creatorOf(req),
        note: body.data.note,
      });
      if (done.kind === 'not_found') return reply.code(404).send({ error: 'not found' });
      if (done.kind === 'not_awaiting') return notAwaiting(reply);
      // The decision is recorded: held files that cannot be deleted now must not undo it.
      try {
        await deleteHeld(store, buckets.runs, done.item);
      } catch (err) {
        req.log.warn({ err, item: done.item.id }, 'a rejected item kept its held files');
      }
      return done.item;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/conversions/items/:id/force',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'forceLoadConversionItem',
        summary: 'Force-load an item',
        description: md`
          Delivers the item's stored file again as an explicit update, in a new batch of one that
          starts at once: an already loaded document is updated (after a better decomposer, say),
          and a duplicate is created as a second document of its own. The target's version check
          still applies. The new item keeps the source key and names the item it reruns
          (\`redeliverOf\`). Refused while an earlier rerun of the item is unfinished, so a
          repeated request makes one batch.
        `,
        params: ItemParams,
        response: RerunResponses,
      },
    },
    async (req, reply) => {
      const item = await findItem(req.params.id);
      if (!item) return reply.code(404).send({ error: 'not found' });
      const batch = await app.deps.repo.getBatch(item.batchId);
      const why = notFinished(item, batch);
      if (why || !batch) return reply.code(409).send({ error: why, code: 'not_finished' });
      if (!(await takesDocuments(app, batch.targetId))) {
        return reply.code(422).send({ error: NO_DOCUMENTS, code: 'target_takes_no_documents' });
      }
      const ids = { batchId: randomUUID(), itemId: randomUUID() };
      return rerunReply(reply, await rerun(req, ids, item, batch, storedSource(item)));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/conversions/items/:id/redeliver',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'redeliverConversionItem',
        summary: "Redeliver an item's document",
        consumes: ['multipart/form-data'],
        description: md`
          Updates the item's document explicitly, in a new batch of one that starts at once
          (forced; the target's version check still applies). Send no body to deliver the stored
          file again, or a \`multipart/form-data\` body with one \`file\` part, a replacement Word
          document (\`.docx\`) or PDF: it keeps the item's source key, so it updates the same document,
          which is how a renamed or moved file updates the right one. Only an item with a
          register entry has a document to redeliver. Refused while an earlier rerun of the item
          is unfinished, so a repeated request makes one batch and stores one file.
        `,
        params: ItemParams,
        body: multipart({}, [], 'The replacement Word document or PDF (optional).', {
          fileRequired: false,
        }),
        response: {
          ...RerunResponses,
          400: error('A multipart body whose part is not named `file`.'),
          409: res(
            'The item never started, it or a rerun of it is still running (`not_finished`), or ' +
              'it has no register entry (`no_register_entry`: never delivered, or detached).',
            ErrorBody.extend({ code: z.enum(['not_finished', 'no_register_entry']) }),
          ),
          413: error('The replacement is larger than the upload limit.'),
          415: error(`\`${NOT_WORD_OR_PDF}\`.`),
          422: res(
            `\`${TRACKED_CHANGES}\`, a replacement whose name holds a control character ` +
              '(`bad_filename`), or a target that no longer takes documents.',
            ErrorBody.extend({
              code: z.enum(['bad_filename', 'target_takes_no_documents']).optional(),
            }),
          ),
        },
      },
    },
    async (req, reply) => {
      const { repo, store, buckets, maxUploadBytes } = app.deps;
      const item = await findItem(req.params.id);
      if (!item) return reply.code(404).send({ error: 'not found' });
      const batch = await repo.getBatch(item.batchId);
      const why = notFinished(item, batch);
      if (why || !batch) return reply.code(409).send({ error: why, code: 'not_finished' });
      if (!(await entryOf(item))) {
        return reply.code(409).send({ error: NO_ENTRY, code: 'no_register_entry' });
      }
      if (!(await takesDocuments(app, batch.targetId))) {
        return reply.code(422).send({ error: NO_DOCUMENTS, code: 'target_takes_no_documents' });
      }
      const ids = { batchId: randomUUID(), itemId: randomUUID() };
      if (!req.isMultipart()) {
        return rerunReply(reply, await rerun(req, ids, item, batch, storedSource(item)));
      }

      const file = await req.file({ limits: { files: 1, fileSize: maxUploadBytes } });
      if (!file || file.fieldname !== 'file') {
        return reply.code(400).send({ error: 'the replacement part must be named file' });
      }
      if (hasControlCharacter(file.filename)) {
        return reply.code(422).send({ error: BAD_FILENAME, code: 'bad_filename' });
      }
      const body = await file.toBuffer(); // throws RequestFileTooLargeError (413) past the limit
      const source = checkSource(body);
      if (!source.ok && source.code === 422) return reply.code(422).send({ error: source.error });
      if (!source.ok) return reply.code(415).send({ error: NOT_WORD_OR_PDF });
      const objectKey = decompositionSourceKey(ids.batchId, ids.itemId, source.ext);
      await store.put(buckets.runs, objectKey, body, source.contentType);
      // Whatever happens to the rerun (refused, or the database fails), no file is left behind.
      const unstore = async () => {
        try {
          await store.delete(buckets.runs, objectKey);
        } catch (err) {
          req.log.warn({ err, key: objectKey }, 'a refused replacement file was not deleted');
        }
      };
      let done: RerunResult;
      try {
        done = await rerun(req, ids, item, batch, {
          filename: file.filename,
          contentSha256: createHash('sha256').update(body).digest('hex'),
          sizeBytes: body.length,
          objectKey,
        });
      } catch (err) {
        await unstore();
        throw err;
      }
      if (!done.ok) await unstore();
      return rerunReply(reply, done);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/conversions/items/:id/detach',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'detachConversionItem',
        summary: "Detach an item's document",
        description: md`
          Forgets the register entry of the item's document: the entry is kept only as a record
          that it was detached. The document stays in the target, untouched, and the next run of
          the same source creates a new document, even from the same file. Refused while a
          delivery for it, or a run of its file on the same target, is in flight, and unless the
          document is refused as changed in the target, its versions were never recorded (the
          item's \`unversioned\`) or the target no longer has it (the item's \`gone\`)
          (\`not_refused\`), so a live document is never detached, from an old row or a stale
          page. Recorded with who and when; the item's detail says it was detached.
        `,
        params: ItemParams,
        response: {
          200: res(
            'The item: its detail says it was detached, and its `resolution` is `detached`.',
            ItemSchema,
          ),
          404: error('No such item.'),
          409: res(
            'The item has no register entry (`no_register_entry`: never delivered, or detached ' +
              'already), a delivery for it or a run of its file is in flight (`in_flight`), or ' +
              'its document is neither refused as changed in the target, unversioned nor gone ' +
              '(`not_refused`).',
            ErrorBody.extend({ code: z.enum(['no_register_entry', 'in_flight', 'not_refused']) }),
          ),
        },
      },
    },
    async (req, reply) => {
      const item = await findItem(req.params.id);
      if (!item) return reply.code(404).send({ error: 'not found' });
      const entry = await entryOf(item);
      const detached = entry
        ? await app.deps.repo.detachRegisterEntry({
            itemId: item.id,
            entryId: entry.id,
            targetIds: await tenantTargets(entry),
            by: batchCreator(creatorOf(req)),
            detail: (e) =>
              `detached${e.persistentId ? ` from document ${e.persistentId}` : ''}: ` +
              'the next run of this source creates a new document',
          })
        : ({ ok: false, reason: 'missing' } as const);
      if (detached.ok) return detached.item;
      if (detached.reason === 'pending') {
        return reply.code(409).send({ error: IN_FLIGHT, code: 'in_flight' });
      }
      if (detached.reason === 'not_refused') {
        return reply.code(409).send({ error: NOT_REFUSED, code: 'not_refused' });
      }
      return reply.code(409).send({ error: NO_ENTRY, code: 'no_register_entry' });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/conversions/items/:id/reload',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'reloadConversionItem',
        summary: 'Load an item as a new document',
        description: md`
          For a document the target no longer has (the item's \`gone\`: the sink refused its
          update with the missing-document marker, \`not_found\` with details
          \`reason: document_missing\` naming that document; deleted there, say), or one whose
          register entry is still the detached tombstone (no later create has replaced it), and
          only when the row is not superseded (the item's \`reloadable\`): detaches its
          register entry if it is not detached yet (recorded with who, when and
          \`reason: gone\`), then delivers the item's stored file as a plain create (not forced),
          in a new batch of one that starts at once. After the detach, that makes a **new**
          document in the target. The new item keeps the source key and names the item it reruns
          (\`redeliverOf\`). Refused while an earlier rerun of the item is unfinished, so a
          repeated request (a double click) makes one batch.
        `,
        params: ItemParams,
        response: {
          ...RerunResponses,
          409: res(
            'The item never started, it or a rerun of it is still running (`not_finished`), its ' +
              'document is not reloadable (`not_gone`: neither gone nor still detached, or ' +
              'superseded), or a ' +
              'delivery of it or a run of its file is in flight (`in_flight`).',
            ErrorBody.extend({ code: z.enum(['not_finished', 'not_gone', 'in_flight']) }),
          ),
        },
      },
    },
    async (req, reply) => {
      const item = await findItem(req.params.id);
      if (!item) return reply.code(404).send({ error: 'not found' });
      const batch = await app.deps.repo.getBatch(item.batchId);
      const why = notFinished(item, batch);
      if (why || !batch) return reply.code(409).send({ error: why, code: 'not_finished' });
      // `reloadable` (read from the entry as it is now): gone, or still the detached tombstone,
      // and not superseded. An item that only reads `detached` because a later create replaced
      // the tombstone has a live document again.
      const entry = item.registerEntryId
        ? await app.deps.repo.registerEntry(item.registerEntryId)
        : null;
      if (!item.reloadable || !entry) {
        return reply.code(409).send({ error: NOT_GONE, code: 'not_gone' });
      }
      if (!(await takesDocuments(app, batch.targetId))) {
        return reply.code(422).send({ error: NO_DOCUMENTS, code: 'target_takes_no_documents' });
      }
      if (isGone(entry)) {
        const detached = await app.deps.repo.detachRegisterEntry({
          itemId: item.id,
          entryId: entry.id,
          targetIds: await tenantTargets(entry),
          by: batchCreator(creatorOf(req)),
          reason: 'gone',
          detail: (e) =>
            `detached${e.persistentId ? ` from document ${e.persistentId}` : ''}, gone from the ` +
            'target: loading it as a new document',
        });
        // Detached meanwhile (a second click) is as good: the rerun's guard makes one batch.
        if (!detached.ok && detached.reason === 'pending') {
          return reply.code(409).send({ error: IN_FLIGHT, code: 'in_flight' });
        }
        if (!detached.ok && detached.reason === 'not_refused') {
          return reply.code(409).send({ error: NOT_GONE, code: 'not_gone' });
        }
      }
      const ids = { batchId: randomUUID(), itemId: randomUUID() };
      // The tombstone is checked again with the batch insert, in one transaction.
      const done = await app.deps.repo.rerunItem({
        ...ids,
        of: item,
        targetId: batch.targetId,
        createdBy: batchCreator(creatorOf(req)),
        by: creatorOf(req),
        source: storedSource(item),
        force: false,
        whileDetached: entry.id,
      });
      if (!done.ok && done.reason === 'not_detached') {
        return reply.code(409).send({ error: NOT_GONE, code: 'not_gone' });
      }
      return rerunReply(reply, done);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/conversions/items/:id/accept',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'previewAcceptTargetState',
        summary: "Preview accepting the target's state",
        description: md`
          What accepting the target's current state would record for a document refused as
          changed in the target: each component the refusal listed, with its version when it
          was delivered (\`expected\`) and now (\`actual\`, null when it is gone). The target does
          not say who changed it. \`acceptable\` is false, with the \`reason\`, when it can't be
          accepted here: the document is not changed in the target, the refusal lists only some
          of the changes, or the document is gone. Detach it instead. \`updatedAt\` says which
          state of the register entry this is; the confirm sends it back as \`seen\`.
        `,
        params: ItemParams,
        response: { 200: res('The preview.', AcceptPreviewSchema), 404: error('No such item.') },
      },
    },
    async (req, reply) => {
      const item = await findItem(req.params.id);
      if (!item) return reply.code(404).send({ error: 'not found' });
      const entry = await entryOf(item);
      if (!entry) return { changed: [], acceptable: false, reason: NO_ENTRY, updatedAt: null };
      const { changed, reason } = acceptPlanOf(entry);
      const { updatedAt } = entry;
      return reason === null
        ? { changed, acceptable: true, updatedAt }
        : { changed, acceptable: false, reason, updatedAt };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/conversions/items/:id/accept',
    {
      schema: {
        tags: ['Conversions'],
        operationId: 'acceptTargetState',
        summary: "Accept the target's state",
        description: md`
          Takes the target's current versions (as the preview lists them) into the register
          entry, so that the next run of the source is an update that goes through, even from the
          same file, **overwriting the edits made in the target**. The body must be
          \`{ "confirm": true, "seen": <the preview's updatedAt> }\`: if the entry changed since
          that preview, the confirm is refused (409 \`stale_preview\`) and the preview must be
          looked at again. Recorded with who, when and the components. If the document changes
          again before the next run, that update is refused again. Refused (422) where the
          preview says it can't be accepted.
        `,
        params: ItemParams,
        body: AcceptTargetStateSchema,
        response: {
          200: res('The item and the components accepted.', AcceptedTargetStateSchema),
          400: error('The body is not `{ confirm: true, seen }`.'),
          404: error('No such item.'),
          409: res(
            'The item has no register entry (`no_register_entry`), or the entry changed since ' +
              'the preview (`stale_preview`).',
            ErrorBody.extend({ code: z.enum(['no_register_entry', 'stale_preview']) }),
          ),
          422: CodedError('It cannot be accepted here: the error says why.', 'not_acceptable'),
        },
      },
    },
    async (req, reply) => {
      const body = AcceptTargetStateSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const item = await findItem(req.params.id);
      if (!item) return reply.code(404).send({ error: 'not found' });
      const accepted = item.registerEntryId
        ? await app.deps.repo.acceptTargetState({
            itemId: item.id,
            entryId: item.registerEntryId,
            seen: body.data.seen,
            by: batchCreator(creatorOf(req)),
            plan: acceptPlanOf,
            detail: (e) =>
              `the target's state was accepted: the next run of this source updates document ` +
              `${e.persistentId}, overwriting the edits made in the target`,
          })
        : ({ ok: false, reason: 'missing' } as const);
      if (accepted.ok) return { item: accepted.item, changed: accepted.changed };
      if (accepted.reason === 'not_acceptable') {
        return reply.code(422).send({ error: accepted.why, code: 'not_acceptable' });
      }
      if (accepted.reason === 'stale') {
        return reply.code(409).send({ error: STALE_PREVIEW, code: 'stale_preview' });
      }
      return reply.code(409).send({ error: NO_ENTRY, code: 'no_register_entry' });
    },
  );
};
