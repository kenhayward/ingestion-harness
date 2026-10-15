import type { FastifyPluginAsync } from 'fastify';
import {
  OntologySuggestionsViewSchema,
  ontologySuggestionsKey,
  vocabularyOf,
  EMPTY_BRIEF,
} from '@ih/shared';
import { error, md, res } from '../openapi/zod.js';
import { refuseRetired, RETIRED_DOC } from '../templates/retirement.js';
import { currentSurvey, ontologyLibrary, suggestionsView } from '../workbench/suggestions.js';
import { PROJECT_NOT_FOUND, ProjectIdParams } from './workbench.js';

/** Ontology suggestions (survey, ADR 0011 follow-up). */
export const workbenchSuggestionRoutes: FastifyPluginAsync = async (app) => {
  const { workbench } = app.deps;

  app.get<{ Params: { id: string } }>(
    '/workbench/projects/:id/ontology-suggestions',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'getOntologySuggestions',
        summary: 'Get the ontology suggestions',
        description: md`
          The library ontologies suggested as vocabularies for this document type, from the
          survey's candidate data: each with the candidates it covers and the matching terms.
          The record is the current survey's (the newest accepted survey, else the newest
          finished one), refreshed or not. \`stale\` is \`survey\` when it comes from an earlier
          survey and \`library\` when the ready library or the embedding model changed since;
          \`running\` while a refresh is queued or running; \`failed\` holds a refresh's error.
        `,
        params: ProjectIdParams,
        response: {
          200: res('The suggestions.', OntologySuggestionsViewSchema),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      return suggestionsView(app, req.params.id);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/workbench/projects/:id/ontology-suggestions',
    {
      preHandler: refuseRetired(app),
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'refreshOntologySuggestions',
        summary: 'Refresh the ontology suggestions',
        description: md`
          Queues a refresh of the ontology suggestions from the current survey's candidates
          against the library as it is now (no model call; the candidates are embedded only by a
          local embedding model or when the project allows external models). A project has one
          refresh at a time: a new one replaces the old. Poll \`GET\`.
        `,
        params: ProjectIdParams,
        response: {
          202: res('The suggestions, with the refresh running.', OntologySuggestionsViewSchema),
          404: PROJECT_NOT_FOUND,
          409: error(
            `\`run the survey first\`, \`the ontology library has no ready versions\`, or ${RETIRED_DOC}`,
          ),
        },
      },
    },
    async (req, reply) => {
      const projectId = req.params.id;
      const project = await workbench.getProject(projectId);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const survey = await currentSurvey(app, projectId);
      if (!survey?.candidates.length) {
        return reply.code(409).send({ error: 'run the survey first' });
      }
      const library = await ontologyLibrary(app);
      if (!library.length) {
        return reply.code(409).send({ error: 'the ontology library has no ready versions' });
      }
      const brief = await workbench.latestBrief(projectId);
      const { removed } = await app.deps.repo.createSuggestJob(projectId, {
        surveyProposalId: survey.id,
        candidates: survey.candidates,
        library,
        pinned: vocabularyOf(brief?.body ?? EMPTY_BRIEF).map((v) => ({
          ontologyId: v.ontologyId,
          version: v.version,
        })),
        dataPolicy: project.dataPolicy,
      });
      await Promise.all(
        removed.map((id) =>
          app.deps.store
            .delete(app.deps.buckets.runs, ontologySuggestionsKey(projectId, id))
            .catch((err: unknown) => req.log.warn({ err, id }, 'old suggestions not deleted')),
        ),
      );
      return reply.code(202).send(await suggestionsView(app, projectId));
    },
  );
};
