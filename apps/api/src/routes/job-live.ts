import { PassThrough } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import { JobSummarySchema, type JobLive } from '@ih/shared';
import { z } from 'zod';
import { error, md } from '../openapi/zod.js';
import { jobProgress, PROGRESS_EVENTS, stageTimes } from '../jobs/progress.js';

const UUID = z.string().uuid();
const JobParams = z.object({ id: z.string().describe('The job id.') });

/** Every stream re-reads its job this often, and sends a comment so proxies keep it open. */
export const LIVE_HEARTBEAT_MS = 15_000;

const isActive = (status: string) => status === 'queued' || status === 'running';

/**
 * A job's live stream (Server-Sent Events): Home follows the latest job with it. Changes arrive
 * through `deps.jobWatch` (Postgres NOTIFY); a heartbeat re-reads the job too, so the stream
 * works, only slower, without a watch or after a lost notification.
 */
export const jobLiveRoutes: FastifyPluginAsync = async (app) => {
  /** Open streams, ended before the server closes (an open stream would hold `close()`). */
  const open = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const end of [...open]) end();
  });

  async function live(id: string): Promise<JobLive | null> {
    const job = await app.deps.repo.getJob(id);
    if (!job) return null;
    const parsed = JobSummarySchema.safeParse(job); // without outputs
    const summary = parsed.success ? parsed.data : job;
    const events = await app.deps.repo.latestEvents([id], PROGRESS_EVENTS);
    return {
      job: summary,
      progress: jobProgress(summary, events),
      stageTimes: stageTimes(summary, events),
    };
  }

  app.get<{ Params: { id: string } }>(
    '/jobs/:id/events',
    {
      schema: {
        tags: ['Jobs'],
        operationId: 'watchJob',
        summary: "Follow a job's status and progress",
        description: md`
          A [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
          stream. Each \`job\` event's data is JSON \`{ job, progress, stageTimes }\`: the job
          summary, when this attempt finished reading the document and found its sections and,
          while an extraction runs, where it is (\`prepare\`: the text layer or OCR page
          \`page\` of \`of\`; \`segmented\`; \`step\`: extract step \`index\` of \`of\`, its
          attempt and chunk). It is sent at once and again whenever either changes. The stream
          ends after the job leaves \`queued\` and \`running\` (it is sent first), and with a
          \`gone\` event when the job is deleted. A comment line keeps it open every 15 s.
        `,
        params: JobParams,
        response: {
          200: {
            description: 'The event stream.',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
          404: error('`not found`.'),
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      if (!UUID.safeParse(id).success) return reply.code(404).send({ error: 'not found' });
      const first = await live(id);
      if (!first) return reply.code(404).send({ error: 'not found' });

      const stream = new PassThrough();
      let last = '';
      let ended = false;
      let busy: Promise<void> = Promise.resolve();
      const end = () => {
        if (ended) return;
        ended = true;
        clearInterval(heartbeat);
        unsubscribe();
        open.delete(end);
        stream.end();
      };
      const send = (current: JobLive | null) => {
        if (ended) return;
        if (!current) {
          stream.write('event: gone\ndata: {}\n\n');
          return end();
        }
        const data = JSON.stringify(current);
        if (data !== last) stream.write(`event: job\ndata: ${data}\n\n`);
        last = data;
        if (!isActive(current.job.status)) end();
      };
      // Reads run one at a time, in order, so an older read never overwrites a newer one.
      const refresh = () => {
        busy = busy
          .then(async () => (ended ? undefined : send(await live(id))))
          .catch((err: unknown) => req.log.warn({ err, jobId: id }, 'job stream read failed'));
      };
      const unsubscribe = app.deps.jobWatch?.subscribe(id, refresh) ?? (() => {});
      const heartbeat = setInterval(() => {
        if (ended) return;
        stream.write(': ping\n\n');
        refresh();
      }, app.deps.liveHeartbeatMs ?? LIVE_HEARTBEAT_MS);
      open.add(end);
      req.raw.on('close', end);

      stream.write('retry: 3000\n\n');
      send(first);
      return reply
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache')
        .header('x-accel-buffering', 'no') // nginx: pass each event on at once
        .send(stream);
    },
  );
};
