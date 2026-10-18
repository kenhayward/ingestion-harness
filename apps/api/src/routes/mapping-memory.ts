import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  answerTerms,
  MappingMemoryDetailSchema,
  MappingMemoryPageSchema,
  MemoryCreateBodySchema,
  MemoryListQuerySchema,
  MemoryPatchBodySchema,
  signatureOf,
  type MappingMemoryEntry,
  type RememberedAnswer,
  type MemoryTermLabels,
} from '@ih/shared';
import { error, md, noContent, res } from '../openapi/zod.js';
import { ontologyLibrary } from '../workbench/suggestions.js';

/**
 * The mapping memory on the Ontologies page (docs/design/mapping-memory.md, section 6): the
 * mappings designers accepted, which designers confirm, correct, reject or delete. Operators
 * reach none of it (not in the operator allow-list).
 */

const Params = z.object({ id: z.string().describe('The entry id.') });

/** `<id>@<version>` (where the library found a term) as people read it: `<id> v<version>`. */
const versionName = (definedIn: string) => definedIn.replace('@', ' v');
const NOT_FOUND = error('`entry not found`.');

export async function mappingMemoryRoutes(app: FastifyInstance): Promise<void> {
  const by = (req: FastifyRequest) => req.auth?.label ?? null;
  const base = (operationId: string, summary: string, description: string) => ({
    tags: ['Ontologies'],
    operationId,
    summary,
    description,
  });

  /** The library's newest ready versions, by id (retired ontologies are left out). */
  const library = async () => new Map((await ontologyLibrary(app)).map((v) => [v.id, v]));

  /** Labels of the entries' terms, and each entry's stale reason; entries whose ontologies
   * are all gone from the library (retired or deleted) are left out. */
  const enrich = async (
    entries: MappingMemoryEntry[],
  ): Promise<{ entries: MappingMemoryEntry[]; labels: MemoryTermLabels }> => {
    const lib = await library();
    const versions = [...lib.values()].map((v) => ({ id: v.id, version: v.version }));
    const iris = [...new Set(entries.flatMap((e) => answerTerms(e.answer)))];
    const found = iris.length ? await app.deps.ontologies.termLabels(versions, iris) : {};
    const labels: MemoryTermLabels = Object.fromEntries(
      Object.entries(found).map(([iri, f]) => [
        iri,
        {
          label: f.label,
          kind: f.kind,
          deprecated: f.deprecated,
          ontology: f.ontology,
          altLabels: f.altLabels,
          definition: f.definition,
        },
      ]),
    );
    const out = entries
      .filter((e) => !e.ontologies.length || e.ontologies.some((o) => lib.has(o)))
      .map((e) => {
        const reasons = answerTerms(e.answer).flatMap((iri) => {
          const f = found[iri];
          if (!f) return [`${iri} is not in ${e.ontologies.join(', ') || 'the library'} any more`];
          return f.deprecated ? [`${f.label} is deprecated in ${versionName(f.ontology)}`] : [];
        });
        return { ...e, stale: reasons.length ? reasons.join('; ') : null };
      });
    return { entries: out, labels };
  };

  /** The library ontologies holding every term of the answer; a problem when one is unknown. */
  const termsCheck = async (
    answer: RememberedAnswer,
  ): Promise<{ ontologies: string[] } | { problem: string }> => {
    const lib = await library();
    const versions = [...lib.values()].map((v) => ({ id: v.id, version: v.version }));
    const iris = answerTerms(answer);
    const found = iris.length ? await app.deps.ontologies.termLabels(versions, iris) : {};
    const missing = iris.filter((i) => !found[i]);
    if (missing.length) return { problem: `not in the ontology library: ${missing.join(', ')}` };
    const ids = Object.values(found).map((f) => f.ontology.split('@')[0]!);
    return { ontologies: [...new Set(ids)].sort() };
  };

  app.get(
    '/ontologies/memory',
    {
      schema: {
        ...base(
          'listMappingMemory',
          'Remembered mappings',
          md`
            The mappings designers accepted in recipes, one entry per kind of output and
            answer, most used first: its wording, the answer (full IRIs, labelled in
            \`labels\`), the recipes voting for it, refusals and its review. \`status\`:
            \`review\` (learned, not yet confirmed), \`confirmed\`, \`rejected\` or \`all\`
            (default); \`ontology\`, \`term\` (an IRI the answer uses) and \`q\` (wording) filter.
            An entry is \`stale\` when a term is missing or deprecated in the newest version of
            its ontology; entries of retired ontologies are left out.
          `,
        ),
        querystring: MemoryListQuerySchema,
        response: {
          200: res('A page of entries.', MappingMemoryPageSchema),
          400: error('Zod issues.'),
        },
      },
    },
    async (req, reply) => {
      const query = MemoryListQuerySchema.safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: query.error.issues });
      const page = await app.deps.mappingMemory.list(query.data);
      const { entries, labels } = await enrich(page.entries);
      return { entries, total: page.total, labels };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/ontologies/memory/:id',
    {
      schema: {
        ...base(
          'getMappingMemoryEntry',
          'A remembered mapping',
          md`
            One entry with every recipe output voting for it (recipe id, output path and
            version), its refusals and review, its stale reason and its terms' labels.
          `,
        ),
        params: Params,
        response: { 200: res('The entry.', MappingMemoryDetailSchema), 404: NOT_FOUND },
      },
    },
    async (req, reply) => {
      const entry = await app.deps.mappingMemory.get(req.params.id);
      if (!entry) return reply.code(404).send({ error: 'entry not found' });
      const { entries, labels } = await enrich([entry]);
      return { entry: entries[0] ?? { ...entry }, labels };
    },
  );

  app.post(
    '/ontologies/memory',
    {
      schema: {
        ...base(
          'addMappingMemoryEntry',
          'Add a remembered mapping',
          md`
            Adds what an output worded like this should map to; it starts confirmed, so the
            mapping stage pre-selects it. An entry with the same wording and answer is
            confirmed instead. Every term must be in the ontology library.
          `,
        ),
        body: MemoryCreateBodySchema,
        response: {
          201: res('The entry.', MappingMemoryDetailSchema),
          400: error('Zod issues, or `not in the ontology library: <IRIs>`.'),
        },
      },
    },
    async (req, reply) => {
      const body = MemoryCreateBodySchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const b = body.data;
      const check = await termsCheck(b.answer);
      if ('problem' in check) return reply.code(400).send({ error: check.problem });
      const sig = signatureOf({
        kind: b.kind,
        name: b.name,
        description: b.description,
        type: b.type,
        table: b.table,
      });
      const entry = await app.deps.mappingMemory.create(
        {
          kind: b.kind,
          signatureKey: sig.key,
          name: b.name,
          description: b.description ?? '',
          type: b.type ?? '',
          unit: sig.unit,
          answer: b.answer,
          ontologies: check.ontologies,
          note: b.note ?? null,
          external: false,
        },
        by(req),
      );
      req.log.info({ entry: entry.id }, 'remembered mapping added');
      const { entries, labels } = await enrich([entry]);
      return reply.code(201).send({ entry: entries[0] ?? entry, labels });
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/ontologies/memory/:id',
    {
      schema: {
        ...base(
          'reviewMappingMemoryEntry',
          'Confirm, reject or correct a remembered mapping',
          md`
            Any designer may confirm (pre-selected at high confidence), reject (never
            offered again for such outputs) or correct the answer (it is then confirmed). A
            field left out is kept; \`note: null\` clears the note. Records who and when.
          `,
        ),
        params: Params,
        body: MemoryPatchBodySchema,
        response: {
          200: res('The entry.', MappingMemoryDetailSchema),
          400: error('Zod issues, or `not in the ontology library: <IRIs>`.'),
          404: NOT_FOUND,
          409: error('`an entry already holds this answer for such outputs`.'),
        },
      },
    },
    async (req, reply) => {
      const body = MemoryPatchBodySchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if (body.data.answer) {
        const check = await termsCheck(body.data.answer);
        if ('problem' in check) return reply.code(400).send({ error: check.problem });
      }
      const out = await app.deps.mappingMemory.patch(req.params.id, body.data, by(req));
      if (out === null) return reply.code(404).send({ error: 'entry not found' });
      if (out === 'conflict') {
        return reply
          .code(409)
          .send({ error: 'an entry already holds this answer for such outputs' });
      }
      req.log.info({ entry: out.id, status: out.status }, 'remembered mapping reviewed');
      const { entries, labels } = await enrich([out]);
      return { entry: entries[0] ?? out, labels };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/ontologies/memory/:id',
    {
      schema: {
        ...base(
          'deleteMappingMemoryEntry',
          'Delete a remembered mapping',
          md`
            Deletes the entry with its votes and refusals. Recipes that still give this
            answer bring it back on their next save; rejecting is the way to stop one.
          `,
        ),
        params: Params,
        response: { 204: noContent('Deleted.'), 404: NOT_FOUND },
      },
    },
    async (req, reply) => {
      const deleted = await app.deps.mappingMemory.delete(req.params.id);
      if (!deleted) return reply.code(404).send({ error: 'entry not found' });
      req.log.info({ entry: req.params.id }, 'remembered mapping deleted');
      return reply.code(204).send();
    },
  );
}
