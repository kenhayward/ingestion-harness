import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  AcceptedTargetStateSchema,
  AcceptPreviewSchema,
  AcceptTargetStateSchema,
  BatchDetailSchema,
  BatchSchema,
  BatchSummarySchema,
  ConversionTargetSchema,
  CreateBatchSchema,
  decompositionReportKey,
  decompositionSourceKey,
  DOCX_MIME,
  hasControlCharacter,
  ItemSchema,
  MAX_SOURCE_KEY,
  sourceKeyProblem,
  type Batch,
  type Item,
  type ItemOutcome,
} from '@ih/shared';
import { z } from 'zod';
import { creatorOf } from '../access/routes.js';
import { acceptPlanOf } from '../conversions/accept.js';
import { batchCreator, type AddItemResult, type Rerun } from '../conversions/repo.js';
import { ErrorBody, error, md, multipart, noContent, res } from '../openapi/zod.js';
import { checkSource, multipartField, TRACKED_CHANGES } from '../uploads.js';

/** What an upload that isn't a Word document gets: PDFs come with decomposition phase 5. */
export const NOT_A_WORD_DOCUMENT = 'file is not a Word document (.docx)';
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
const IN_FLIGHT = 'a delivery of this document is in flight';
/** The outcomes of an item not finished yet: a row action waits for its outcome. */
const RUNNING: readonly ItemOutcome[] = ['queued', 'decomposing', 'delivering'];

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
          Send it **before** the file part. A source key is relative and \`/\`-separated
          (at most ${MAX_SOURCE_KEY} characters; no control characters, backslashes, empty,
          \`.\` or \`..\` parts, or \`/\` at either end) and is stored in its NFC form.
          Another is refused (422 \`bad_source_key\`), as is a file name with a control
          character (422 \`bad_filename\`).

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
          400: error('A missing `file` part (the part must be named `file`) or `sourceKey`.'),
          404: NOT_FOUND,
          406: error('The request is not `multipart/form-data`.'),
          409: error('The batch is not open, or the source key is already in it.'),
          413: error('The file is larger than the upload limit.'),
          415: error(`\`${NOT_A_WORD_DOCUMENT}\`.`),
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
      if (!source.ok || source.kind !== 'docx') {
        return reply.code(415).send({ error: NOT_A_WORD_DOCUMENT });
      }

      const id = randomUUID();
      const objectKey = decompositionSourceKey(batchId, id, 'docx');
      await store.put(buckets.runs, objectKey, body, DOCX_MIME);
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
      : RUNNING.includes(item.outcome)
        ? 'the item is still running'
        : null;

  /** The item's register entry: the one its delivery settled, or the worker decided about. */
  const entryOf = async (item: Item) =>
    item.registerEntryId ? app.deps.repo.registerEntry(item.registerEntryId) : null;

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
    409: CodedError('The item never started, or is still running.', 'not_finished'),
    422: CodedError("The batch's target no longer takes documents.", 'target_takes_no_documents'),
  };

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
          (\`redeliverOf\`).
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
      const done = await rerun(req, ids, item, batch, storedSource(item));
      return reply.code(201).send({ batch: done.batch, items: [done.item] });
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
          document (\`.docx\`): it keeps the item's source key, so it updates the same document,
          which is how a renamed or moved file updates the right one. Only an item with a
          register entry has a document to redeliver.
        `,
        params: ItemParams,
        body: {
          type: 'object',
          properties: {
            file: {
              type: 'string',
              format: 'binary',
              description: 'The replacement Word document (optional).',
            },
          },
        },
        response: {
          ...RerunResponses,
          400: error('A multipart body whose part is not named `file`.'),
          409: res(
            'The item never started, is still running (`not_finished`), or has no register ' +
              'entry (`no_register_entry`).',
            ErrorBody.extend({ code: z.enum(['not_finished', 'no_register_entry']) }),
          ),
          413: error('The replacement is larger than the upload limit.'),
          415: error(`\`${NOT_A_WORD_DOCUMENT}\`.`),
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
        const done = await rerun(req, ids, item, batch, storedSource(item));
        return reply.code(201).send({ batch: done.batch, items: [done.item] });
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
      if (!source.ok || source.kind !== 'docx') {
        return reply.code(415).send({ error: NOT_A_WORD_DOCUMENT });
      }
      const objectKey = decompositionSourceKey(ids.batchId, ids.itemId, 'docx');
      await store.put(buckets.runs, objectKey, body, DOCX_MIME);
      try {
        const done = await rerun(req, ids, item, batch, {
          filename: file.filename,
          contentSha256: createHash('sha256').update(body).digest('hex'),
          sizeBytes: body.length,
          objectKey,
        });
        return reply.code(201).send({ batch: done.batch, items: [done.item] });
      } catch (err) {
        await store.delete(buckets.runs, objectKey); // no file is left behind
        throw err;
      }
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
          Forgets the register entry of the item's document. The document stays in the target,
          untouched, and the next run of the same source creates a new document. Refused while
          a delivery for it is in flight. Recorded with who and when; the item's detail says it
          was detached.
        `,
        params: ItemParams,
        response: {
          200: res('The item, its detail saying it was detached.', ItemSchema),
          404: error('No such item.'),
          409: res(
            'The item has no register entry (`no_register_entry`: never delivered, or detached ' +
              'already), or a delivery for it is in flight (`in_flight`).',
            ErrorBody.extend({ code: z.enum(['no_register_entry', 'in_flight']) }),
          ),
        },
      },
    },
    async (req, reply) => {
      const item = await findItem(req.params.id);
      if (!item) return reply.code(404).send({ error: 'not found' });
      const detached = item.registerEntryId
        ? await app.deps.repo.detachRegisterEntry(
            item.id,
            item.registerEntryId,
            batchCreator(creatorOf(req)),
            (e) =>
              `detached${e.persistentId ? ` from document ${e.persistentId}` : ''}: ` +
              'the next run of this source creates a new document',
          )
        : ({ ok: false, reason: 'missing' } as const);
      if (detached.ok) return detached.item;
      if (detached.reason === 'pending') {
        return reply.code(409).send({ error: IN_FLIGHT, code: 'in_flight' });
      }
      return reply.code(409).send({ error: NO_ENTRY, code: 'no_register_entry' });
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
          of the changes, or the document is gone. Detach it instead.
        `,
        params: ItemParams,
        response: { 200: res('The preview.', AcceptPreviewSchema), 404: error('No such item.') },
      },
    },
    async (req, reply) => {
      const item = await findItem(req.params.id);
      if (!item) return reply.code(404).send({ error: 'not found' });
      const entry = await entryOf(item);
      if (!entry) return { changed: [], acceptable: false, reason: NO_ENTRY };
      const { changed, reason } = acceptPlanOf(entry);
      return reason === null
        ? { changed, acceptable: true }
        : { changed, acceptable: false, reason };
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
          entry, so that the next run's update goes through, **overwriting the edits made in the
          target**. The body must be \`{ "confirm": true }\`. Recorded with who, when and the
          components. If the document changes again before the next run, that update is refused
          again. Refused (422) where the preview says it can't be accepted.
        `,
        params: ItemParams,
        body: AcceptTargetStateSchema,
        response: {
          200: res('The item and the components accepted.', AcceptedTargetStateSchema),
          400: error('The body is not `{ confirm: true }`.'),
          404: error('No such item.'),
          409: CodedError('The item has no register entry.', 'no_register_entry'),
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
        ? await app.deps.repo.acceptTargetState(
            item.id,
            item.registerEntryId,
            batchCreator(creatorOf(req)),
            acceptPlanOf,
            (e) =>
              `the target's state was accepted: the next run updates document ${e.persistentId}`,
          )
        : ({ ok: false, reason: 'missing' } as const);
      if (accepted.ok) return { item: accepted.item, changed: accepted.changed };
      if (accepted.reason === 'not_acceptable') {
        return reply.code(422).send({ error: accepted.why, code: 'not_acceptable' });
      }
      return reply.code(409).send({ error: NO_ENTRY, code: 'no_register_entry' });
    },
  );
};
