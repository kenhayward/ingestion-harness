import { describe, expect, it } from 'vitest';
import type { JobOutput, JobSummary } from '@ih/shared';
import { fakePdf, multipart, testApp } from './helpers.js';

/** ADR 0011 step 7: deleting a job or retiring a type withdraws what was delivered. */

const published = (jobId: string): JobOutput[] => [
  {
    outputId: 'fields',
    stage: 'published',
    format: 'csv',
    bucket: 'ingest-published',
    key: `demo/v1/fields/${jobId}.csv`,
    rowCount: 1,
    targetId: 'default',
  },
  {
    outputId: 'fields',
    stage: 'draft',
    format: 'csv',
    bucket: 'ingest-outputs',
    key: `demo/v1/fields/${jobId}.csv`,
    rowCount: 1,
    targetId: null,
  },
];

async function setup() {
  const ctx = await testApp();
  const upload = async (content: Buffer = fakePdf) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'demo' }, { filename: 'a.pdf', content }),
    });
    const job = res.json() as JobSummary;
    ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status: 'succeeded' });
    return job;
  };
  const sha = async (job: JobSummary) => ctx.repo.documents.get(job.documentId)!.sha256;
  const graphIri = (s: string) => `https://data.acme.example/graph/source/${s}/demo`;
  return { ...ctx, upload, sha, graphIri };
}

describe('deleting a delivered job', () => {
  it('queues a withdraw of its published objects and of the graph it published last', async () => {
    const { app, repo, upload, sha, graphIri } = await setup();
    const job = await upload();
    const s = await sha(job);
    repo.outputs.set(job.id, published(job.id));
    repo.publishGraph({ sha256: s, templateId: 'demo', graphIri: graphIri(s), jobId: job.id });
    expect((await app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}` })).statusCode).toBe(
      204,
    );
    const [withdraw] = repo.backgroundJobs;
    expect(withdraw).toMatchObject({ task: 'withdraw', priority: 0, maxAttempts: 100 });
    expect(withdraw!.params).toEqual({
      objects: [
        { bucket: 'ingest-published', key: `demo/v1/fields/${job.id}.csv`, target: 'default' },
      ],
      graphs: [
        { sha256: s, templateId: 'demo', graphIri: graphIri(s), target: 'default', versions: [1] },
      ],
    });
    expect(repo.currentGraphs()).toEqual([]);
  });

  it('keeps the graph when another job published its current version', async () => {
    const { app, repo, upload, sha, graphIri } = await setup();
    const first = await upload();
    const second = await upload();
    const s = await sha(first);
    repo.publishGraph({ sha256: s, templateId: 'demo', graphIri: graphIri(s), jobId: first.id });
    repo.publishGraph({ sha256: s, templateId: 'demo', graphIri: graphIri(s), jobId: second.id });
    await app.inject({ method: 'DELETE', url: `/api/jobs/${first.id}` });
    expect(repo.backgroundJobs[0]!.params).toEqual({
      objects: [],
      graphs: [{ sha256: s, templateId: 'demo', graphIri: null, target: 'default', versions: [1] }],
    });
    expect(repo.currentGraphs()).toEqual([
      expect.objectContaining({ sha256: s, version: 2, jobId: second.id }),
    ]);
  });

  it('queues nothing for a job that delivered nothing', async () => {
    const { app, repo, upload } = await setup();
    const job = await upload();
    repo.outputs.set(
      job.id,
      published(job.id).filter((o) => o.stage === 'draft'),
    );
    await app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}` });
    expect(repo.backgroundJobs).toEqual([]);
  });
});

describe('withdrawing through the recorded publishing targets', () => {
  const onTarget = (jobId: string, targetId: string, bucket: string): JobOutput => ({
    outputId: 'fields',
    stage: 'published',
    format: 'csv',
    bucket,
    key: `${targetId}/demo/fields/${jobId}.csv`,
    rowCount: 1,
    targetId,
  });

  it("names each object's and each graph copy's own target when a type retires", async () => {
    const { app, repo, upload, sha, graphIri } = await setup();
    const v1 = await upload();
    const v2 = await upload(Buffer.from('%PDF-1.7\nanother\n'));
    repo.outputs.set(v1.id, [onTarget(v1.id, 'default', 'ingest-published')]);
    repo.outputs.set(v2.id, [onTarget(v2.id, 'finance-lake', 'finance-lake')]);
    const s = await sha(v1);
    // One document's graph: version 1 delivered to default, version 2 to finance-lake.
    repo.publishGraph({ sha256: s, templateId: 'demo', graphIri: graphIri(s), jobId: v1.id });
    repo.publishGraph({
      sha256: s,
      templateId: 'demo',
      graphIri: graphIri(s),
      jobId: v2.id,
      targetId: 'finance-lake',
    });
    await app.inject({ method: 'PUT', url: '/api/specs/demo/retirement' });
    expect(repo.backgroundJobs[0]!.params).toEqual({
      objects: [
        {
          bucket: 'ingest-published',
          key: `default/demo/fields/${v1.id}.csv`,
          target: 'default',
        },
        {
          bucket: 'finance-lake',
          key: `finance-lake/demo/fields/${v2.id}.csv`,
          target: 'finance-lake',
        },
      ],
      graphs: [
        { sha256: s, templateId: 'demo', graphIri: null, target: 'default', versions: [1] },
        {
          sha256: s,
          templateId: 'demo',
          graphIri: graphIri(s),
          target: 'finance-lake',
          versions: [2],
        },
      ],
    });
  });

  it('names the recorded target when a delivered job is deleted', async () => {
    const { app, repo, upload, sha, graphIri } = await setup();
    const job = await upload();
    const s = await sha(job);
    repo.outputs.set(job.id, [onTarget(job.id, 'finance-lake', 'finance-lake')]);
    repo.publishGraph({
      sha256: s,
      templateId: 'demo',
      graphIri: graphIri(s),
      jobId: job.id,
      targetId: 'finance-lake',
    });
    await app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}` });
    expect(repo.backgroundJobs[0]!.params).toEqual({
      objects: [
        {
          bucket: 'finance-lake',
          key: `finance-lake/demo/fields/${job.id}.csv`,
          target: 'finance-lake',
        },
      ],
      graphs: [
        {
          sha256: s,
          templateId: 'demo',
          graphIri: graphIri(s),
          target: 'finance-lake',
          versions: [1],
        },
      ],
    });
  });
});

describe('retiring and unretiring a document type', () => {
  it('withdraws every delivered output and graph once; unretiring re-delivers', async () => {
    const { app, repo, upload, sha, graphIri } = await setup();
    const job = await upload();
    const s = await sha(job);
    repo.outputs.set(job.id, published(job.id));
    repo.publishGraph({ sha256: s, templateId: 'demo', graphIri: graphIri(s), jobId: job.id });

    expect(
      (await app.inject({ method: 'PUT', url: '/api/specs/demo/retirement' })).statusCode,
    ).toBe(200);
    expect(repo.backgroundJobs.map((j) => [j.task, j.params])).toEqual([
      [
        'withdraw',
        {
          objects: [
            { bucket: 'ingest-published', key: `demo/v1/fields/${job.id}.csv`, target: 'default' },
          ],
          graphs: [
            {
              sha256: s,
              templateId: 'demo',
              graphIri: graphIri(s),
              target: 'default',
              versions: [1],
            },
          ],
        },
      ],
    ]);
    // Withdrawn outputs are no longer offered; the job and its drafts stay.
    const detail = (await app.inject(`/api/jobs/${job.id}`)).json() as { outputs: JobOutput[] };
    expect(detail.outputs.map((o) => o.stage)).toEqual(['draft']);
    expect(repo.currentGraphs()).toEqual([]);

    await app.inject({ method: 'PUT', url: '/api/specs/demo/retirement' }); // again: nothing new
    expect(repo.backgroundJobs).toHaveLength(1);

    expect(
      (await app.inject({ method: 'DELETE', url: '/api/specs/demo/retirement' })).statusCode,
    ).toBe(204);
    expect(repo.backgroundJobs.at(-1)).toMatchObject({
      task: 'republish',
      priority: -10,
      params: { templateId: 'demo' },
    });
  });

  it('unretiring with nothing withdrawn queues no republish', async () => {
    const { app, repo } = await setup();
    await app.inject({ method: 'PUT', url: '/api/specs/demo/retirement' });
    await app.inject({ method: 'DELETE', url: '/api/specs/demo/retirement' });
    expect(repo.backgroundJobs).toEqual([]);
  });
});

describe('withdrawal status', () => {
  it('counts withdrawals that need review with the failed ones', async () => {
    const { repo } = await setup();
    repo.backgroundJobs.push(
      {
        id: 'a',
        task: 'withdraw',
        priority: 0,
        maxAttempts: 100,
        params: {},
        status: 'needs_review',
        createdBy: null,
      },
      {
        id: 'b',
        task: 'republish',
        priority: -10,
        maxAttempts: 10,
        params: {},
        status: 'failed',
        createdBy: null,
      },
      {
        id: 'c',
        task: 'withdraw',
        priority: 0,
        maxAttempts: 100,
        params: {},
        status: 'queued',
        createdBy: null,
      },
    );
    expect(await repo.withdrawalStatus()).toEqual({ queued: 1, running: 0, failed: 2 });
  });
});
