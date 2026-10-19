import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  pluginPreviewKey,
  preparedTextKey,
  preparedTriageKey,
  type PluginInfo,
  type SampleView,
} from '@ih/shared';
import { MemoryPluginCatalogue } from '../src/plugins/catalogue.js';
import { SEGMENT_PRIORITY } from '../src/repositories/types.js';
import { letter, multipart, testApp } from './helpers.js';

const catalogue = JSON.parse(
  readFileSync(
    new URL('../../../packages/shared/test/fixtures/plugin-catalogue.json', import.meta.url),
    'utf8',
  ),
) as { plugins: PluginInfo[] };
const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);

/** The letter recipe with its step as a text.pattern@1 plugin step. */
const withPlugin = {
  ...letter(1),
  pipeline: [
    {
      type: 'plugin',
      id: 'head',
      uses: 'text.pattern@1',
      fields: ['sender'],
      sections: ['all'],
      with: { patterns: { sender: 'From: (.+)' } },
    },
  ],
};

async function project({
  definition = withPlugin as object,
  plugins = catalogue.plugins,
}: { definition?: object; plugins?: PluginInfo[] } = {}) {
  const ctx = await testApp({ plugins: new MemoryPluginCatalogue(plugins) });
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await ctx.templates.updateDraft('letter', 1, definition as Record<string, unknown>);
  const add = async (n: number, { role = 'dev', prepared = true } = {}) => {
    const sample = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role }, { filename: `s${n}.pdf`, content: pdf(n) }),
      })
    ).json() as SampleView;
    if (!prepared) return sample;
    const job = ctx.repo.jobs.get(sample.prepareJobId!)!;
    ctx.repo.jobs.set(job.id, { ...job, status: 'succeeded' });
    const triage = { sha256: sample.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
    await ctx.store.put('runs', preparedTriageKey(sample.sha256), Buffer.from(JSON.stringify(triage)), 'application/json');
    const text = { sha256: sample.sha256, pages: [{ number: 1, text: 'From: Acme', ocr: false }] };
    await ctx.store.put('runs', preparedTextKey(sample.sha256), Buffer.from(JSON.stringify(text)), 'application/json');
    return sample;
  };
  const preview = (payload: object = { stepId: 'head' }) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/plugin-previews',
      payload,
    });
  return { ...ctx, add, preview };
} // prettier-ignore

describe('plugin step previews', () => {
  it('queues a preview of the step on every ready dev sample, with the open draft', async () => {
    const { add, preview, repo } = await project();
    const s1 = await add(1);
    const s2 = await add(2);
    await add(3, { role: 'holdout' });
    await add(4, { prepared: false });

    const res = await preview();
    expect(res.statusCode).toBe(202);
    const view = res.json();
    expect(view).toMatchObject({ status: 'queued', error: null, result: null });
    const stored = repo.pluginJobs.get(view.jobId)!;
    expect(stored.params).toEqual({
      stepId: 'head',
      definition: withPlugin,
      samples: [
        { sampleId: s1.id, fileName: 's1.pdf', sha256: s1.sha256 },
        { sampleId: s2.id, fileName: 's2.pdf', sha256: s2.sha256 },
      ],
    });
    expect(repo.priorities.get(view.jobId)).toBe(SEGMENT_PRIORITY);
  });

  it('previews only the samples asked for', async () => {
    const { add, preview, repo } = await project();
    const s1 = await add(1);
    await add(2);
    const res = await preview({ stepId: 'head', sampleIds: [s1.id] });
    expect(res.statusCode).toBe(202);
    expect(repo.pluginJobs.get(res.json().jobId)!.params.samples).toHaveLength(1);
  });

  it('keeps one preview per project, deleting the old one and its result', async () => {
    const { add, preview, repo, store } = await project();
    await add(1);
    const first = (await preview()).json().jobId as string;
    await store.put(
      'runs',
      pluginPreviewKey('letter', first),
      Buffer.from('{}'),
      'application/json',
    );
    const second = (await preview()).json().jobId as string;
    expect(repo.pluginJobs.has(first)).toBe(false);
    expect(repo.pluginJobs.has(second)).toBe(true);
    expect(await store.get('runs', pluginPreviewKey('letter', first))).toBeNull();
  });

  it('refuses a step the recipe does not have', async () => {
    const { add, preview } = await project();
    await add(1);
    const res = await preview({ stepId: 'nope' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('no plugin step nope in the recipe');
  });

  it('refuses a step that is not a plugin step', async () => {
    const { add, preview } = await project({ definition: letter(1) });
    await add(1);
    const res = await preview({ stepId: 'head' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('no plugin step head in the recipe');
  });

  it('refuses a plugin no worker has published', async () => {
    const { add, preview } = await project({ plugins: [] });
    await add(1);
    const res = await preview();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no plugin text.pattern@1 on this deployment's workers");
  });

  it('refuses a plugin that sends data out', async () => {
    const { add, preview } = await project({
      plugins: [{ ...catalogue.plugins[0]!, egress: 'model' }],
    });
    await add(1);
    const res = await preview();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('only plugins that send no data out can be previewed yet');
  });

  it('needs a prepared dev sample', async () => {
    const { add, preview } = await project();
    await add(1, { prepared: false });
    const res = await preview();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no prepared dev samples to preview: add samples first');
  });

  it.each<[string, (s: SampleView) => string[], number, string]>([
    ['an unknown sample', () => ['00000000-0000-4000-8000-000000000000'], 400, 'unknown sample 00000000-0000-4000-8000-000000000000'],
    ['a holdout sample', (s) => [s.id], 400, 'plugin previews use dev samples only'],
  ])('refuses %s', async (_, ids, status, error) => {
    const { add, preview } = await project();
    const holdout = await add(1, { role: 'holdout' });
    const res = await preview({ stepId: 'head', sampleIds: ids(holdout) });
    expect(res.statusCode).toBe(status);
    expect(res.json().error).toBe(error);
  }); // prettier-ignore

  it('404s an unknown project', async () => {
    const { app } = await project();
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/nope/plugin-previews',
      payload: { stepId: 'head' },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns a preview's result once it succeeded", async () => {
    const { add, preview, repo, store, app } = await project();
    await add(1);
    const jobId = (await preview()).json().jobId as string;
    const url = `/api/workbench/projects/letter/plugin-previews/${jobId}`;
    expect((await app.inject(url)).json()).toMatchObject({ status: 'queued', result: null });

    const result = {
      stepId: 'head',
      uses: 'text.pattern@1',
      problem: null,
      samples: [
        {
          sampleId: 's',
          fileName: 's1.pdf',
          fields: { sender: { value: 'Acme', evidence: 'From: Acme', page: 1 } },
          rows: null,
          issues: [],
          error: null,
        },
      ],
    };
    await store.put('runs', pluginPreviewKey('letter', jobId), Buffer.from(JSON.stringify(result)), 'application/json');
    repo.pluginJobs.set(jobId, { ...repo.pluginJobs.get(jobId)!, status: 'succeeded' });
    expect((await app.inject(url)).json()).toEqual({ jobId, status: 'succeeded', error: null, result });
  }); // prettier-ignore

  it("says when a succeeded preview's result is missing, and 404s another project's", async () => {
    const { add, preview, repo, app } = await project();
    await add(1);
    const jobId = (await preview()).json().jobId as string;
    repo.pluginJobs.set(jobId, { ...repo.pluginJobs.get(jobId)!, status: 'succeeded' });
    const url = `/api/workbench/projects/letter/plugin-previews/${jobId}`;
    expect((await app.inject(url)).json()).toMatchObject({ error: 'result missing', result: null });
    const other = await app.inject(`/api/workbench/projects/memo/plugin-previews/${jobId}`);
    expect(other.statusCode).toBe(404);
  });
});
