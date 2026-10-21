import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ChoiceCreateBodySchema,
  choiceIdFrom,
  ChoicePatchBodySchema,
  CuratedModelsBodySchema,
  ModelSettingsBodySchema,
  EndpointCreateBodySchema,
  EndpointPatchBodySchema,
  isOffered,
  LlmChoicesViewSchema,
  LlmChoiceViewSchema,
  LlmEndpointViewSchema,
  modelUses,
  SettingsBodySchema,
} from '@ih/shared';
import { z } from 'zod';
import { encryptSecret } from '../llm/secrets.js';
import { error, md, noContent, res } from '../openapi/zod.js';

const ADR =
  'https://github.com/kenhayward/ingestion-harness/blob/main/docs/adr/0010-llm-endpoints-in-the-database.md';
const ADMINS_ONLY = error('`admins only`.');
const NOT_FOUND = error('`endpoint not found`.');
const NO_SECRETS = 'LLM_SECRETS_KEY is not set: the API cannot store keys';
const IN_USE = error(
  '`model choice {label} uses {ref}: point it elsewhere first`, or `the drafting model …` / ' +
    '`the OCR model …`.',
);
const NOT_OFFERED = '{ref} is not offered: add it under Administration > Models';
const ChoiceParams = z.object({ id: z.string().describe('The model choice id.') });
const NameParams = z.object({ name: z.string().describe('The endpoint name (model-ref prefix).') });
const base = (operationId: string, summary: string, description: string) => ({
  tags: ['Models'],
  'x-admin': true,
  operationId,
  summary,
  description,
});

/**
 * LLM endpoints and their curated models (ADR 0010), for Administration > Models. Admins only; the
 * access hook has already required a session (`deps.access === null` disables both in unit
 * tests). Keys are encrypted here and never returned.
 */
export async function llmRoutes(app: FastifyInstance): Promise<void> {
  const repo = app.deps.llm;

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.deps.access && req.auth?.role !== 'admin') {
      return reply.code(403).send({ error: 'admins only' });
    }
  });

  const by = (req: FastifyRequest) => req.auth?.label ?? null;
  const encrypt = (key: string) =>
    app.deps.llmSecrets ? encryptSecret(key, app.deps.llmSecrets) : null;

  /** The first model choice (by id) or pipeline model whose ref `matches` accepts, as a 409. */
  const aliasUsing = async (matches: (ref: string) => boolean): Promise<string | null> => {
    const [choices, settings] = await Promise.all([repo.listChoices(), repo.getSettings()]);
    const use = modelUses(choices, settings).find((u) => matches(u.ref));
    return use ? `${use.what} uses ${use.ref}: point it elsewhere first` : null;
  };
  /** Choices and pipeline models may only point at offered models; null when `ref` is one. */
  const notOffered = async (ref: string) => {
    const offered = (await app.deps.repo.listModels()).some((m) => isOffered(m) && m.ref === ref);
    return offered ? null : `model ${ref} is not offered: add it under Administration > Models`;
  };
  const choicesView = async () => {
    const [choices, settings] = await Promise.all([repo.listChoices(), repo.getSettings()]);
    return { choices, settings };
  };

  app.get(
    '/llm/endpoints',
    {
      schema: {
        ...base(
          'listLlmEndpoints',
          'List LLM endpoints and their models',
          md`
            **Admins only.** Every endpoint, seeded from \`.env\` or added by an admin,
            with every model the database knows for it: \`curated\` ones are offered in the
            pickers, the others were discovered on the endpoint (suggestions). A key entered
            here is never returned, only \`keySet\`. See [ADR 0010](${ADR}).`,
        ),
        response: { 200: res('The endpoints.', z.array(LlmEndpointViewSchema)), 403: ADMINS_ONLY },
      },
    },
    async () => repo.listEndpoints(),
  );

  app.post(
    '/llm/endpoints',
    {
      schema: {
        ...base(
          'createLlmEndpoint',
          'Add an LLM endpoint',
          md`
            **Admins only.** Adds an endpoint (\`source: ui\`) with the models to
            offer. Its name becomes the model-ref prefix (\`name/model-id\`). An \`apiKey\` is
            stored encrypted with \`LLM_SECRETS_KEY\` (409 without it). Workers pick the change
            up within seconds.
          `,
        ),
        body: EndpointCreateBodySchema,
        response: {
          201: res('The endpoint.', LlmEndpointViewSchema),
          400: error('Zod issues.'),
          403: ADMINS_ONLY,
          409: error(`\`an endpoint named {name} already exists\`, or \`${NO_SECRETS}\`.`),
        },
      },
    },
    async (req, reply) => {
      const body = EndpointCreateBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { apiKey, ...input } = body.data;
      const apiKeyEnc = apiKey === undefined ? null : encrypt(apiKey);
      if (apiKey !== undefined && apiKeyEnc === null) {
        return reply.code(409).send({ error: NO_SECRETS });
      }
      const created = await repo.createEndpoint({ ...input, apiKeyEnc }, by(req));
      if (created === 'exists') {
        return reply.code(409).send({ error: `an endpoint named ${input.name} already exists` });
      }
      req.log.info({ endpoint: input.name, location: input.location }, 'llm endpoint added');
      return reply.code(201).send(created);
    },
  );

  app.patch<{ Params: { name: string } }>(
    '/llm/endpoints/:name',
    {
      schema: {
        ...base(
          'updateLlmEndpoint',
          'Change an LLM endpoint',
          md`
            **Admins only.** Changes the kind, base URL, \`location\` (what the data
            policy allows), enabled flag, \`toolCalls\` (whether Workbench drafting may use
            tools on it; off: single replies, as before tools) or key (\`apiKey\`: a new one,
            stored encrypted, or \`null\` to remove it). The edit is recorded (\`editedAt\`, \`updatedBy\`) and
            \`.env\` no longer changes the endpoint. Disabling an endpoint an alias uses is
            refused.
          `,
        ),
        params: NameParams,
        body: EndpointPatchBodySchema,
        response: {
          200: res('The endpoint.', LlmEndpointViewSchema),
          400: error('Zod issues (`nothing to change` for an empty body).'),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error(
            `\`alias {name} uses {ref}: point it elsewhere first\`, or \`${NO_SECRETS}\`.`,
          ),
        },
      },
    },
    async (req, reply) => {
      const body = EndpointPatchBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { name } = req.params;
      if (!(await repo.getEndpoint(name))) {
        return reply.code(404).send({ error: 'endpoint not found' });
      }
      const { apiKey, ...rest } = body.data;
      let apiKeyEnc: string | null | undefined;
      if (typeof apiKey === 'string') {
        apiKeyEnc = encrypt(apiKey);
        if (apiKeyEnc === null) return reply.code(409).send({ error: NO_SECRETS });
      } else {
        apiKeyEnc = apiKey; // null removes the stored key; undefined keeps it
      }
      if (rest.enabled === false) {
        const used = await aliasUsing((ref) => ref.startsWith(`${name}/`));
        if (used) return reply.code(409).send({ error: used });
      }
      const updated = await repo.updateEndpoint(name, { ...rest, apiKeyEnc }, by(req));
      req.log.info(
        { endpoint: name, changed: Object.keys(body.data), by: by(req) },
        'llm endpoint changed',
      );
      return updated ?? reply.code(404).send({ error: 'endpoint not found' });
    },
  );

  app.put<{ Params: { name: string } }>(
    '/llm/endpoints/:name/models',
    {
      schema: {
        ...base(
          'setLlmEndpointModels',
          "Choose an endpoint's models",
          md`
            **Admins only.** Exactly these models are offered in the pickers for this
            endpoint: ids not known yet are added, curated ones left out are withdrawn (they stay
            as suggestions). Withdrawing a model an alias uses is refused. \`.env\` no longer
            changes these choices.
          `,
        ),
        params: NameParams,
        body: CuratedModelsBodySchema,
        response: {
          200: res('The endpoint.', LlmEndpointViewSchema),
          400: error('Zod issues.'),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: IN_USE,
        },
      },
    },
    async (req, reply) => {
      const body = CuratedModelsBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { name } = req.params;
      const models = [...new Set(body.data.models)];
      if (!(await repo.getEndpoint(name))) {
        return reply.code(404).send({ error: 'endpoint not found' });
      }
      const used = await aliasUsing(
        (ref) => ref.startsWith(`${name}/`) && !models.includes(ref.slice(name.length + 1)),
      );
      if (used) return reply.code(409).send({ error: used });
      const updated = await repo.setCuratedModels(name, models, by(req));
      return updated ?? reply.code(404).send({ error: 'endpoint not found' });
    },
  );

  app.patch<{ Params: { name: string; modelId: string } }>(
    '/llm/endpoints/:name/models/:modelId',
    {
      schema: {
        ...base(
          'setLlmModelSettings',
          "Set a model's output limit and parallel calls",
          md`
            **Admins only.** \`maxOutputTokens\` is the most tokens one reply of this model may
            use where the step does not say: the Workbench drafting stages and the mapping stage
            (16,000 when null). A reply cut off at the limit fails the stage with a message that
            names this setting. Mainly a property of the model, so set it to what the model and
            its context window allow.

            \`maxConcurrentCalls\` (1 to 32) is how many calls the workers together may send this
            model at once: a step's occurrence and chunk calls, and OCR pages. Each call holds
            one of the model's slots (a Postgres advisory lock of its worker, freed if the worker
            dies) and waits while every slot is in use. Null: no slots, one call at a time in
            each worker (OCR keeps \`ocr.concurrency\` of the config file). Set it to what the
            model's server serves at once (LM Studio's parallel requests). A setting left out of
            the body is kept; null clears it. A model id containing \`/\` is URL-encoded.
          `,
        ),
        params: NameParams.extend({
          modelId: z.string().describe('The model id on this endpoint.'),
        }),
        body: ModelSettingsBodySchema,
        response: {
          200: res('The endpoint.', LlmEndpointViewSchema),
          400: error('Zod issues.'),
          403: ADMINS_ONLY,
          404: error('`endpoint not found` or `model not found`.'),
        },
      },
    },
    async (req, reply) => {
      const body = ModelSettingsBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { name, modelId } = req.params;
      if (!(await repo.getEndpoint(name))) {
        return reply.code(404).send({ error: 'endpoint not found' });
      }
      const updated = await repo.setModelSettings(name, modelId, body.data, by(req));
      return updated ?? reply.code(404).send({ error: 'model not found' });
    },
  );

  app.delete<{ Params: { name: string } }>(
    '/llm/endpoints/:name',
    {
      schema: {
        ...base(
          'deleteLlmEndpoint',
          'Remove an LLM endpoint',
          md`
            **Admins only.** Removes an endpoint added in the UI. One seeded from
            \`.env\` would come back on the next worker start, so it can only be disabled.
            Removing an endpoint an alias uses is refused.
          `,
        ),
        params: NameParams,
        response: {
          204: noContent('Removed.'),
          403: ADMINS_ONLY,
          404: NOT_FOUND,
          409: error(
            '`{name} comes from .env: disable it instead`, or `alias {name} uses {ref}: point it ' +
              'elsewhere first`.',
          ),
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params;
      const endpoint = await repo.getEndpoint(name);
      if (!endpoint) return reply.code(404).send({ error: 'endpoint not found' });
      if (endpoint.source === 'env') {
        return reply.code(409).send({ error: `${name} comes from .env: disable it instead` });
      }
      const used = await aliasUsing((ref) => ref.startsWith(`${name}/`));
      if (used) return reply.code(409).send({ error: used });
      const outcome = await repo.deleteEndpoint(name);
      if (outcome === 'missing') return reply.code(404).send({ error: 'endpoint not found' });
      if (outcome === 'env') {
        return reply.code(409).send({ error: `${name} comes from .env: disable it instead` });
      }
      req.log.info({ endpoint: name, by: by(req) }, 'llm endpoint removed');
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { name: string } }>(
    '/llm/endpoints/:name/discover',
    {
      schema: {
        ...base(
          'discoverLlmEndpoint',
          'List the models an endpoint serves now',
          md`
            **Admins only.** Asks the workers to list every endpoint's models now
            rather than at the next discovery interval; what they find shows as suggestions
            (\`curated: false\`) within seconds.
          `,
        ),
        params: NameParams,
        response: { 202: noContent('Requested.'), 403: ADMINS_ONLY, 404: NOT_FOUND },
      },
    },
    async (req, reply) => {
      if (!(await repo.requestDiscover(req.params.name))) {
        return reply.code(404).send({ error: 'endpoint not found' });
      }
      return reply.code(202).send();
    },
  );

  app.get(
    '/llm/choices',
    {
      schema: {
        ...base(
          'listModelChoices',
          'List model choices and pipeline settings',
          md`
            **Admins only.** The labelled model choices people pick (each pointing at
            an offered model) and the pipeline settings: the default choice (used by recipe
            steps that name none), the drafting model and the OCR model. See [ADR 0010](${ADR}).`,
        ),
        response: { 200: res('The choices and settings.', LlmChoicesViewSchema), 403: ADMINS_ONLY },
      },
    },
    async () => choicesView(),
  );

  app.post(
    '/llm/choices',
    {
      schema: {
        ...base(
          'createModelChoice',
          'Add a model choice',
          md`
            **Admins only.** A labelled choice ("Main Production Model") pointing at an
            offered model. Its \`id\`, what recipes and jobs store, is made from the label
            when left out (\`main-production-model\`, with a suffix if taken).
          `,
        ),
        body: ChoiceCreateBodySchema,
        response: {
          201: res('The choice.', LlmChoiceViewSchema),
          400: error('Zod issues.'),
          403: ADMINS_ONLY,
          409: error(`\`a model choice {id} already exists\`, or \`model ${NOT_OFFERED}\`.`),
        },
      },
    },
    async (req, reply) => {
      const body = ChoiceCreateBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const problem = await notOffered(body.data.ref);
      if (problem) return reply.code(409).send({ error: problem });
      const { id: given, ...rest } = body.data;
      let id = given ?? choiceIdFrom(rest.label);
      if (!given) {
        const taken = new Set((await repo.listChoices()).map((c) => c.id));
        for (let n = 2; taken.has(id); n++) id = `${choiceIdFrom(rest.label)}-${n}`;
      }
      const created = await repo.createChoice({ id, ...rest }, by(req));
      if (created === 'exists') {
        return reply.code(409).send({ error: `a model choice ${id} already exists` });
      }
      req.log.info({ choice: id, ref: rest.ref, by: by(req) }, 'model choice added');
      return reply.code(201).send(created);
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/llm/choices/:id',
    {
      schema: {
        ...base(
          'updateModelChoice',
          'Change a model choice',
          md`
            **Admins only.** Renames it, changes its description or points it at
            another offered model. Recipes and jobs keep naming it by id, so a rename changes
            nothing they do; a new model applies to every job queued from then on.
          `,
        ),
        params: ChoiceParams,
        body: ChoicePatchBodySchema,
        response: {
          200: res('The choice.', LlmChoiceViewSchema),
          400: error('Zod issues (`nothing to change` for an empty body).'),
          403: ADMINS_ONLY,
          404: error('`model choice not found`.'),
          409: error(`\`model ${NOT_OFFERED}\`.`),
        },
      },
    },
    async (req, reply) => {
      const body = ChoicePatchBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if (body.data.ref) {
        const problem = await notOffered(body.data.ref);
        if (problem) return reply.code(409).send({ error: problem });
      }
      const updated = await repo.updateChoice(req.params.id, body.data, by(req));
      return updated ?? reply.code(404).send({ error: 'model choice not found' });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/llm/choices/:id',
    {
      schema: {
        ...base(
          'deleteModelChoice',
          'Remove a model choice',
          md`
            **Admins only.** Refused while it is the default choice, while a recipe
            step (any version) names it, or while an unfinished job (queued, running or
            awaiting review) uses it.
          `,
        ),
        params: ChoiceParams,
        response: {
          204: noContent('Removed.'),
          403: ADMINS_ONLY,
          404: error('`model choice not found`.'),
          409: error(
            '`{label} is the default choice: make another choice the default first`, ' +
              '`{label} is used by {recipe} v{n} (step {id})`, or ' +
              '`{label} is used by {n} unfinished job(s)`.',
          ),
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const choice = await repo.getChoice(id);
      if (!choice) return reply.code(404).send({ error: 'model choice not found' });
      const settings = await repo.getSettings();
      if (settings.defaultChoice === id) {
        return reply.code(409).send({
          error: `${choice.label} is the default choice: make another choice the default first`,
        });
      }
      // Raw steps, not the parsed schema: a draft that is not valid yet still names the choice.
      for (const record of await app.deps.templates.list()) {
        const pipeline = (record.definition as { pipeline?: unknown }).pipeline;
        const step = Array.isArray(pipeline)
          ? (pipeline as { id?: unknown; model?: unknown }[]).find((s) => s?.model === id)
          : undefined;
        if (step) {
          return reply.code(409).send({
            error: `${choice.label} is used by ${record.id} v${record.version} (step ${String(step.id)})`,
          });
        }
      }
      const jobs = await app.deps.repo.countUnfinishedJobsWithModel(id);
      if (jobs) {
        return reply.code(409).send({
          error: `${choice.label} is used by ${jobs} unfinished ${jobs === 1 ? 'job' : 'jobs'}`,
        });
      }
      await repo.deleteChoice(id);
      req.log.info({ choice: id, by: by(req) }, 'model choice removed');
      return reply.code(204).send();
    },
  );

  app.put(
    '/llm/settings',
    {
      schema: {
        ...base(
          'setLlmSettings',
          'Set the default choice and the pipeline models',
          md`
            **Admins only.** The default choice (used by recipe steps that name
            none), the drafting model (the Workbench's proposal stages and dev reference runs)
            and the OCR model (the OCR stage only). Both models must be offered. The edit wins
            over \`.env\`.
          `,
        ),
        body: SettingsBodySchema,
        response: {
          200: res('The choices and settings.', LlmChoicesViewSchema),
          400: error(
            'Zod issues (`nothing to change` for an empty body), or `no model choice {id}`.',
          ),
          403: ADMINS_ONLY,
          409: error(`\`model ${NOT_OFFERED}\`.`),
        },
      },
    },
    async (req, reply) => {
      const body = SettingsBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { defaultChoice, draftingModel, ocrModel, embeddingModel } = body.data;
      if (defaultChoice && !(await repo.getChoice(defaultChoice))) {
        return reply.code(400).send({ error: `no model choice ${defaultChoice}` });
      }
      for (const ref of [draftingModel, ocrModel, embeddingModel]) {
        const problem = ref ? await notOffered(ref) : null;
        if (problem) return reply.code(409).send({ error: problem });
      }
      if (embeddingModel) {
        const endpoint = await repo.getEndpoint(embeddingModel.split('/')[0]!);
        if (endpoint?.kind === 'anthropic') {
          return reply
            .code(409)
            .send({ error: 'the embedding model needs an OpenAI-compatible endpoint' });
        }
      }
      const before = (await repo.getSettings()).embeddingModel;
      await repo.setSettings(body.data, by(req));
      if (embeddingModel && embeddingModel !== before) {
        // Each ready ontology version embeds its terms under the new model (ADR 0011).
        const queued = await app.deps.ontologies.createEmbedJobs(embeddingModel);
        req.log.info({ model: embeddingModel, versions: queued }, 'embed jobs queued');
      }
      req.log.info({ changed: Object.keys(body.data), by: by(req) }, 'llm settings changed');
      return choicesView();
    },
  );
}
