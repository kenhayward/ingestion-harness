import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ONTOLOGY_ACCEPT,
  ONTOLOGY_ID_RE,
  ONTOLOGY_MAX_FILES,
  OntologyBatchResultSchema,
  fileOntologyIds,
  OntologyDetailSchema,
  NeighbourhoodQuerySchema,
  NeighbourhoodSchema,
  OntologyFromUrlBodySchema,
  OntologySettingsSchema,
  OntologyPatchSchema,
  OntologySummarySchema,
  OntologyVersionViewSchema,
  TAG_RE,
  TermDetailSchema,
  TermPageSchema,
  TermQuerySchema,
  ontologyFileNameFromUrl,
  ontologyFormat,
  ontologyNormalizedKey,
  ontologySourceExtension,
  ontologySourceKey,
  ontologyUrlProblem,
} from '@ih/shared';
import { binary, error, md, multipart, noContent, res } from '../openapi/zod.js';
import { multipartField } from '../uploads.js';
import { contentDisposition } from './jobs.js';
import { buildNeighbourhood } from '../ontologies/neighbourhood.js';
import {
  type BatchFile,
  folderName,
  isZip,
  leftOut,
  manifestSha,
  readOntologyZip,
  sha256 as sha256Of,
  ZipRefused,
} from '../ontologies/batch.js';
import type { NewBatchMember, StoredSourceFile } from '../ontologies/repo.js';

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

/** Parts a batch may carry: the RDF files of a folder plus the others the web left in. */
const MAX_BATCH_PARTS = ONTOLOGY_MAX_FILES * 4;
const PREFIX_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PathsSchema = z.array(z.string().min(1).max(512)).max(MAX_BATCH_PARTS);

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
        source: { kind: 'upload', sourceKey, sha256, bytes: body.length },
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

  app.post(
    '/ontologies/batch',
    {
      preHandler: adminOnly,
      schema: {
        ...base(
          'importOntologyBatch',
          'Import a folder or zip of ontology files',
          md`
            **Admin token required.** Every ontology file (${ONTOLOGY_ACCEPT}) of a folder, sent
            as one \`file\` part each, or of one \`.zip\` part (hidden entries and others are
            left out), imported in one go, at most ${ONTOLOGY_MAX_FILES} files within the upload
            limit. Fields come before the files:

            - \`mode\`: \`merge\` makes the files one version of the ontology \`id\` (a new
              ontology needs \`label\`); imports between them are \`included\`. The same set of
              files twice is refused (409).
            - \`separate\` makes each file the next version of the ontology
              \`<idPrefix><file name>\`, all imported by one job, so imports between them
              resolve to each other. A file already a version of its ontology is skipped.
            - \`paths\`: a JSON array of the files' paths in the folder, in part order (browsers
              send only the file name).

            The answer lists the versions queued and the files skipped.
          `,
        ),
        'x-admin': true,
        consumes: ['multipart/form-data'],
        body: multipart(
          {
            mode: {
              type: 'string',
              enum: ['merge', 'separate'],
              description: 'How the files land.',
            },
            id: { type: 'string', description: '`merge`: the ontology id, e.g. `idmp-o`.' },
            label: { type: 'string', description: '`merge`: the name of a new ontology.' },
            description: { type: 'string', description: '`merge`: optional description.' },
            idPrefix: {
              type: 'string',
              description: '`separate`: prefix of every id, e.g. `idmp-` (may be empty).',
            },
            tags: { type: 'string', description: 'Comma-separated tags for new ontologies.' },
            localOnly: {
              type: 'string',
              enum: ['true', 'false'],
              description: '`true`: never sent to external models (new ontologies).',
            },
            paths: { type: 'string', description: "JSON array of the files' paths, in order." },
          },
          ['mode'],
          'An ontology file (repeat the part per file), or one .zip. Send them last.',
        ),
        response: {
          202: res('The versions queued and the files skipped.', OntologyBatchResultSchema),
          400: error('A missing or invalid field, no ontology files, too many, or a bad zip.'),
          403: ADMINS_ONLY,
          409: error('`merge`: the same files are already a version of this ontology.'),
          413: error('The files are over the upload limit.'),
        },
      },
    },
    async (req, reply) => {
      const { store, buckets, ontologies, maxUploadBytes, ontologyFetch } = app.deps;
      const fields: Record<string, string> = {};
      const parts: { name: string; body: Buffer }[] = [];
      let total = 0;
      for await (const part of req.parts({
        limits: { files: MAX_BATCH_PARTS, fileSize: maxUploadBytes },
      })) {
        if (part.type === 'field') {
          fields[part.fieldname] = String(part.value);
          continue;
        }
        const body = await part.toBuffer(); // a RequestFileTooLargeError (413) past the limit
        total += body.length;
        if (total > maxUploadBytes) {
          return reply.code(413).send({ error: 'the files are over the upload limit' });
        }
        parts.push({ name: part.filename, body });
      }

      const mode = fields.mode;
      if (mode !== 'merge' && mode !== 'separate') {
        return reply.code(400).send({ error: 'mode must be merge or separate' });
      }
      const tags = parseTags(fields.tags);
      if ('error' in tags) return reply.code(400).send({ error: tags.error });
      const id = (fields.id ?? '').trim();
      const label = (fields.label ?? '').trim();
      const prefix = (fields.idPrefix ?? '').trim();
      if (mode === 'merge') {
        if (!ONTOLOGY_ID_RE.test(id)) return reply.code(400).send({ error: ID_RULE });
        if (!label && !(await ontologies.get(id))) {
          return reply.code(400).send({ error: NAME_REQUIRED });
        }
      } else if (prefix && !PREFIX_RE.test(prefix)) {
        return reply.code(400).send({
          error: 'the id prefix must be up to 40 lowercase letters, digits or dashes',
        });
      }

      // The files: one zip, or the folder's parts named by `paths`.
      let files: BatchFile[];
      let sourceName: string;
      if (parts.length === 1 && isZip(parts[0]!.body)) {
        try {
          files = readOntologyZip(parts[0]!.body, { maxInflated: ontologyFetch.maxBytes });
        } catch (err) {
          if (err instanceof ZipRefused) return reply.code(400).send({ error: err.message });
          throw err;
        }
        sourceName = parts[0]!.name;
      } else if (parts.some((part) => /\.zip$/i.test(part.name))) {
        return reply.code(400).send({ error: 'not a valid zip' });
      } else {
        let paths = parts.map((part) => part.name);
        if (fields.paths !== undefined) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(fields.paths);
          } catch {
            parsed = null;
          }
          const ok = PathsSchema.safeParse(parsed);
          if (!ok.success || ok.data.length !== parts.length) {
            return reply.code(400).send({ error: 'paths must list one path per file' });
          }
          paths = ok.data;
        }
        files = parts.map((part, i) => ({ path: paths[i]!, body: part.body }));
        sourceName = folderName(paths);
      }
      files = files.filter((f) => !leftOut(f.path));
      // Ids depend only on the ontology files' paths, sorted: the same files get the same ids
      // whatever their order (a zip's entries, a folder's parts) or the other files beside them.
      files.sort((a, b) => a.path.localeCompare(b.path));
      const skipped: { fileName: string; ontologyId: string; reason: string }[] = [];
      const kept: { file: BatchFile; ext: string; mediaType: string }[] = [];
      const idOf = (path: string) => (mode === 'merge' ? id : fileOntologyIds([path], prefix)[0]!);
      for (const file of files) {
        const format = ontologyFormat(file.path);
        if (!format) {
          skipped.push({
            fileName: file.path,
            ontologyId: idOf(file.path),
            reason: 'not an ontology file',
          });
        } else if (file.body.length === 0) {
          skipped.push({ fileName: file.path, ontologyId: idOf(file.path), reason: 'empty file' });
        } else kept.push({ file, ext: format.ext, mediaType: format.mediaType });
      }
      const ids =
        mode === 'separate'
          ? fileOntologyIds(
              kept.map((k) => k.file.path),
              prefix,
            )
          : [];
      const rdf = kept.map((k, i) => ({ ...k, ontologyId: mode === 'merge' ? id : ids[i]! }));
      if (!rdf.length) {
        return reply.code(400).send({ error: `no ontology files (${ONTOLOGY_ACCEPT})` });
      }
      if (rdf.length > ONTOLOGY_MAX_FILES) {
        return reply
          .code(400)
          .send({ error: `at most ${ONTOLOGY_MAX_FILES} ontology files per import` });
      }

      const stored: (StoredSourceFile & { ontologyId: string })[] = [];
      for (const { file, ontologyId, ext, mediaType } of rdf) {
        const sha = sha256Of(file.body);
        const sourceKey = ontologySourceKey(ontologyId, sha, ext);
        await store.put(buckets.runs, sourceKey, file.body, mediaType);
        stored.push({
          ontologyId,
          sourceKey,
          fileName: file.path,
          mediaType,
          sha256: sha,
          bytes: file.body.length,
        });
      }
      const meta = (name: string) => ({
        label: name,
        description: (fields.description ?? '').trim(),
        tags: tags.tags,
        localOnly: fields.localOnly === 'true',
      });

      if (mode === 'merge') {
        const result = await ontologies.createVersion({
          ontologyId: id,
          meta: label ? meta(label) : null,
          fileName: sourceName,
          mediaType: '',
          source: {
            kind: 'files',
            files: stored,
            sha256: manifestSha(stored.map((f) => f.sha256)),
            bytes: stored.reduce((n, f) => n + f.bytes, 0),
          },
          by: by(req),
        });
        if (!result.ok) {
          if (result.reason === 'duplicate') {
            return reply
              .code(409)
              .send({ error: `these files are already version ${result.version} of ${id}` });
          }
          return reply.code(400).send({ error: NAME_REQUIRED });
        }
        req.log.info(
          { ontology: id, version: result.version.version, files: stored.length, by: by(req) },
          'ontology imported',
        );
        return reply.code(202).send({ versions: [result.version], skipped });
      }

      const members: NewBatchMember[] = stored.map((f) => ({
        ...f,
        meta: meta(
          f.fileName
            .split(/[\\/]/)
            .pop()!
            .replace(/\.[^.]*$/, ''),
        ),
      }));
      const result = await ontologies.createBatch(members, by(req));
      req.log.info(
        { ontologies: result.versions.length, skipped: result.skipped.length, by: by(req) },
        'ontologies imported',
      );
      return reply.code(202).send({
        versions: result.versions,
        skipped: [...result.skipped, ...skipped],
      });
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
      const sourceKeys = (v: {
        sha256: string | null;
        fileName: string;
        mediaType: string;
        sourceFiles: { fileName: string; sha256: string; mediaType?: string }[] | null;
      }) =>
        v.sourceFiles
          ? v.sourceFiles.map((f) =>
              ontologySourceKey(
                id,
                f.sha256,
                ontologySourceExtension(f.fileName, f.mediaType ?? ''),
              ),
            )
          : v.sha256
            ? [ontologySourceKey(id, v.sha256, ontologySourceExtension(v.fileName, v.mediaType))]
            : [];
      // Versions of a folder share the files that did not change: keep those still used.
      const kept = new Set(
        ((await app.deps.ontologies.get(id))?.versions ?? []).flatMap((v) => sourceKeys(v)),
      );
      const keys = [
        ...sourceKeys(outcome).filter((key) => !kept.has(key)),
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
      if (v?.sourceFiles) {
        return reply
          .code(404)
          .send({ error: `this version was imported from ${v.sourceFiles.length} files` });
      }
      const ext = v?.sha256 ? ontologySourceExtension(v.fileName, v.mediaType) : undefined;
      const body =
        v?.sha256 && ext
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

  app.post(
    '/ontologies/from-url',
    {
      preHandler: adminOnly,
      schema: {
        ...base(
          'importOntologyFromUrl',
          'Import an ontology from a URL',
          md`
            **Admin token required.** Queues the import of an ontology the worker fetches from
            \`url\` as the next version of \`id\` (a new ontology needs \`label\`). Only
            \`https\` URLs on hosts in \`ONTOLOGY_FETCH_ALLOW\` are accepted; the worker
            checks each redirect again, refuses private addresses and caps the size. The
            version has no bytes until it is fetched, and a file identical to an existing
            version fails it.
          `,
        ),
        'x-admin': true,
        body: OntologyFromUrlBodySchema,
        response: {
          202: res('The queued version.', OntologyVersionViewSchema),
          400: error('An invalid body, a URL that cannot be imported, or a missing name.'),
          403: ADMINS_ONLY,
        },
      },
    },
    async (req, reply) => {
      const body = OntologyFromUrlBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { id, url, label } = body.data;
      const problem = ontologyUrlProblem(url, app.deps.ontologyFetch.hosts);
      if (problem) return reply.code(400).send({ error: problem });
      const { ontologies } = app.deps;
      const existing = await ontologies.get(id);
      if (!existing && !label) return reply.code(400).send({ error: NAME_REQUIRED });
      const result = await ontologies.createVersion({
        ontologyId: id,
        meta: existing
          ? null
          : {
              label: label ?? id,
              description: body.data.description ?? '',
              tags: body.data.tags ?? [],
              localOnly: body.data.localOnly ?? false,
            },
        fileName: ontologyFileNameFromUrl(url),
        mediaType: '',
        source: { kind: 'url', url },
        by: by(req),
      });
      if (!result.ok) return reply.code(400).send({ error: NAME_REQUIRED });
      req.log.info(
        { ontology: id, version: result.version.version, url, by: by(req) },
        'ontology import from URL queued',
      );
      return reply.code(202).send(result.version);
    },
  );

  app.get(
    '/ontology-settings',
    {
      schema: {
        ...base(
          'getOntologySettings',
          'How ontologies can be imported',
          md`
            The hosts ontologies may be imported from by URL (\`ONTOLOGY_FETCH_ALLOW\`; empty
            means URL imports are off) and the size limit of a fetched file, for the import
            dialog.
          `,
        ),
        response: { 200: res('The settings.', OntologySettingsSchema) },
      },
    },
    async () => ({
      fetchHosts: app.deps.ontologyFetch.hosts,
      maxBytes: app.deps.ontologyFetch.maxBytes,
    }),
  );

  /** Rows per hop the neighbourhood reads; the builder keeps NEIGHBOURHOOD_LIMIT nodes of them. */
  const HOP_ROWS = 500;

  app.get(
    '/ontologies/:id/versions/:version/neighbourhood',
    {
      schema: {
        ...base(
          'getOntologyNeighbourhood',
          'A term and what it is related to',
          md`
            The graph view of a term: the term, its parents and children, the properties whose
            domain or range it is (and a property's own domain and range), concept schemes and
            broader concepts, and the shapes targeting it, \`depth\` hops out (1 or 2). At most
            150 nodes (\`truncated\` says when more were left out); an IRI the version names but
            does not define is an \`external\` node.
          `,
        ),
        params: VersionParams,
        querystring: NeighbourhoodQuerySchema,
        response: {
          200: res('The neighbourhood.', NeighbourhoodSchema),
          400: error('`iri` is missing, or `depth` is not 1 or 2.'),
          404: NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      const params = VersionParams.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'version not found' });
      const query = NeighbourhoodQuerySchema.safeParse(req.query ?? {});
      if (!query.success) return reply.code(400).send({ error: query.error.issues });
      const { id, version } = params.data;
      const { ontologies } = app.deps;
      if (!(await ontologies.neighbours(id, version, [], 1))) {
        return reply.code(404).send({ error: 'version not found' });
      }
      return buildNeighbourhood(
        query.data.iri,
        query.data.depth,
        async (iris) => (await ontologies.neighbours(id, version, iris, HOP_ROWS)) ?? [],
      );
    },
  );
}
