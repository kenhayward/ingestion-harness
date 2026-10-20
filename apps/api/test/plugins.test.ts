import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PluginInfo } from '@ih/shared';
import { MemoryPluginCatalogue } from '../src/plugins/catalogue.js';
import { settingsProblems } from '../src/plugins/settings.js';
import { seedModelChoices, testApp } from './helpers.js';

/** The catalogue the worker publishes and the settings cases (shared with the worker). */
const catalogue = JSON.parse(
  readFileSync(
    new URL('../../../packages/shared/test/fixtures/plugin-catalogue.json', import.meta.url),
    'utf8',
  ),
) as {
  plugins: PluginInfo[];
  settings: { name: string; ref: string; with: unknown; valid: boolean; error?: string }[];
};
/** A recipe with a plugin step (the first case of the shared plugin-steps fixture). */
const steps = JSON.parse(
  readFileSync(
    new URL('../../../packages/shared/test/fixtures/plugin-steps.json', import.meta.url),
    'utf8',
  ),
) as { base: Record<string, unknown>; cases: { pipeline: Record<string, unknown>[] }[] };

const recipe = (plugin: Record<string, unknown> = {}) => {
  const [first, ...rest] = steps.cases[0]!.pipeline;
  return { ...steps.base, pipeline: [{ ...first, ...plugin }, ...rest] };
};

describe("a plugin's settings against its schema", () => {
  const info = (ref: string) => catalogue.plugins.find((p) => p.ref === ref)!;

  it.each(catalogue.settings.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const problems = settingsProblems(info(c.ref), c.with);
    expect(problems.length === 0, problems.join('; ')).toBe(c.valid);
    if (c.error) expect(problems.join('; ')).toContain(c.error);
  });
});

describe('GET /api/plugins', () => {
  it('lists the plugins the workers published, by ref', async () => {
    const extra: PluginInfo = {
      ...catalogue.plugins[0]!,
      ref: 'acme.lines@2',
      id: 'acme.lines',
      major: 2,
    };
    const { app } = await testApp({
      plugins: new MemoryPluginCatalogue([...catalogue.plugins, extra]),
    });
    const res = await app.inject('/api/plugins');
    expect(res.statusCode).toBe(200);
    expect(res.json().map((p: PluginInfo) => p.ref)).toEqual([
      'acme.lines@2',
      'list.lookup@1',
      'text.pattern@1',
    ]);
    expect(res.json()[2]).toEqual(catalogue.plugins[0]);
  });

  it('is empty before any worker has started', async () => {
    const { app } = await testApp({ plugins: new MemoryPluginCatalogue([]) });
    expect((await app.inject('/api/plugins')).json()).toEqual([]);
  });
});

describe('a recipe naming a plugin', () => {
  const issuesOf = async (app: Awaited<ReturnType<typeof testApp>>['app']) =>
    (await app.inject('/api/templates/letter/versions/1')).json().issues as {
      path: string;
      message: string;
    }[];

  it('is fine when a worker has the plugin and the settings fit its schema', async () => {
    const c = await testApp({ plugins: new MemoryPluginCatalogue(catalogue.plugins) });
    await c.templates.create('letter', 1, recipe(), 'draft');
    expect(await issuesOf(c.app)).toEqual([]);
  });

  it('is a publishing issue when no worker has the plugin', async () => {
    const c = await testApp({ plugins: new MemoryPluginCatalogue(catalogue.plugins) });
    await c.templates.create('letter', 1, recipe({ uses: 'acme.magic@3' }), 'draft');
    expect(await issuesOf(c.app)).toEqual([
      {
        path: 'pipeline.0.uses',
        message: 'step "refs": no plugin acme.magic@3 on this deployment\'s workers',
      },
    ]);
    const publish = await c.app.inject({
      method: 'POST',
      url: '/api/templates/letter/versions/1/publish',
      payload: {},
    });
    expect(publish.statusCode).toBe(400);
    expect((await c.templates.get('letter', 1))!.status).toBe('draft');
  });

  it("is a publishing issue when the settings do not fit the plugin's schema", async () => {
    const c = await testApp({ plugins: new MemoryPluginCatalogue(catalogue.plugins) });
    await c.templates.create('letter', 1, recipe({ with: { pattern: 'x' } }), 'draft');
    expect(await issuesOf(c.app)).toEqual([
      {
        path: 'pipeline.0.with',
        message:
          'step "refs": text.pattern@1 settings: must NOT have additional properties (pattern)',
      },
    ]);
  });

  /** A plugin that calls a model, published next to the fixture's. */
  const asking: PluginInfo = {
    ...catalogue.plugins[0]!,
    ref: 'acme.ask@1',
    id: 'acme.ask',
    egress: 'model',
    settingsSchema: { type: 'object', additionalProperties: false },
  };
  const askStep = { uses: 'acme.ask@1', with: {} };

  it("checks a plugin step's model like an extract step's", async () => {
    const c = await testApp({ plugins: new MemoryPluginCatalogue([asking]) });
    seedModelChoices(c);
    await c.templates.create('letter', 1, recipe({ ...askStep, model: 'fast' }), 'draft');
    expect(await issuesOf(c.app)).toEqual([]);
    await c.templates.create('letter', 2, recipe({ ...askStep, model: 'local/qwen' }), 'draft');
    expect((await c.app.inject('/api/templates/letter/versions/2')).json().issues).toEqual([
      {
        path: 'pipeline.0.model',
        message: 'step "refs": pick a model choice instead of the model local/qwen',
      },
    ]);
  });

  it('warns when a step names a model for a plugin that calls none', async () => {
    const c = await testApp({ plugins: new MemoryPluginCatalogue(catalogue.plugins) });
    seedModelChoices(c);
    await c.templates.create('letter', 1, recipe({ model: 'fast' }), 'draft');
    expect(await issuesOf(c.app)).toEqual([
      {
        path: 'pipeline.0.model',
        message: 'step "refs": text.pattern@1 calls no model, so the step\'s model is not used',
        severity: 'warning',
      },
    ]);
  });

  it('is not checked without a catalogue (unit tests of other routes)', async () => {
    const c = await testApp({ plugins: null });
    await c.templates.create('letter', 1, recipe({ uses: 'acme.magic@3' }), 'draft');
    expect(await issuesOf(c.app)).toEqual([]);
  });

  describe('check plugin', () => {
    /** A check plugin with a strict settings schema, published next to the fixture's. */
    const lookup: PluginInfo = {
      ...catalogue.plugins[0]!,
      ref: 'acme.lookup@1',
      id: 'acme.lookup',
      kind: 'check',
      settingsSchema: { type: 'object', additionalProperties: false },
    };
    /** The fixture recipe with a check step after its plugin step. */
    const withCheck = (check: Record<string, unknown>) => {
      const r = recipe();
      return {
        ...r,
        pipeline: [
          ...(r.pipeline as unknown[]),
          { type: 'check', id: 'x', values: 'reference', ...check },
        ],
      };
    };
    const checkAt = recipe().pipeline.length;
    const seed = async (
      check: Record<string, unknown>,
      plugins = [...catalogue.plugins, lookup],
    ) => {
      const c = await testApp({ plugins: new MemoryPluginCatalogue(plugins) });
      await c.templates.create('letter', 1, withCheck(check), 'draft');
      return c;
    };

    it('is fine when a worker has the check plugin and the settings fit', async () => {
      const c = await seed({ uses: 'acme.lookup@1', with: {} });
      expect(await issuesOf(c.app)).toEqual([]);
    });

    it('is a publishing issue when no worker has the plugin', async () => {
      const c = await seed({ uses: 'acme.gone@1' });
      expect(await issuesOf(c.app)).toEqual([
        {
          path: `pipeline.${checkAt}.uses`,
          message: 'check "x": no plugin acme.gone@1 on this deployment\'s workers',
        },
      ]);
    });

    it('is a publishing issue when the plugin is a step plugin', async () => {
      const c = await seed({ uses: 'text.pattern@1' });
      expect(await issuesOf(c.app)).toEqual([
        {
          path: `pipeline.${checkAt}.uses`,
          message: 'check "x": text.pattern@1 is not a check plugin',
        },
      ]);
    });

    it('is a publishing issue when the settings do not fit', async () => {
      const c = await seed({ uses: 'acme.lookup@1', with: { list: 'x' } });
      expect(await issuesOf(c.app)).toEqual([
        {
          path: `pipeline.${checkAt}.with`,
          message: 'check "x": acme.lookup@1 settings: must NOT have additional properties (list)',
        },
      ]);
    });

    it('is a publishing issue when a plugin step names a check plugin', async () => {
      const c = await testApp({
        plugins: new MemoryPluginCatalogue([...catalogue.plugins, lookup]),
      });
      await c.templates.create('letter', 1, recipe({ uses: 'acme.lookup@1', with: {} }), 'draft');
      expect(await issuesOf(c.app)).toEqual([
        {
          path: 'pipeline.0.uses',
          message: 'step "refs": acme.lookup@1 is a check plugin: use it in a check step',
        },
      ]);
    });

    it('is not checked without a catalogue', async () => {
      const c = await testApp({ plugins: null });
      await c.templates.create('letter', 1, withCheck({ uses: 'acme.gone@1' }), 'draft');
      expect(await issuesOf(c.app)).toEqual([]);
    });
  });
});

describe('re-running a plugin step from review', () => {
  const asking: PluginInfo = {
    ...catalogue.plugins[0]!,
    ref: 'acme.ask@1',
    id: 'acme.ask',
    egress: 'model',
    settingsSchema: { type: 'object', additionalProperties: false },
  };

  async function seed(plugin: Record<string, unknown> = {}, plugins = catalogue.plugins) {
    const c = await testApp({ plugins: new MemoryPluginCatalogue([...plugins, asking]) });
    seedModelChoices(c);
    await c.templates.create('letter', 1, recipe(plugin), 'published');
    const documentId = randomUUID();
    const job = await c.repo.createDocumentAndJob(
      {
        id: documentId,
        filename: 'letter.pdf',
        sha256: 'x',
        sizeBytes: 1,
        specId: 'letter',
        specVersion: 1,
        bucket: 'inbox',
        objectKey: `letter/v1/${documentId}.pdf`,
      },
      null,
    );
    c.repo.jobs.set(job.id, { ...c.repo.jobs.get(job.id)!, status: 'awaiting_review' });
    const rerun = (payload: object) =>
      c.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/steps/refs/rerun`, payload });
    return { ...c, job, rerun };
  }

  it('queues a plugin step again, with guidance for the plugin', async () => {
    const { repo, job, rerun } = await seed();
    const res = await rerun({ instructions: 'The reference starts with INV.' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'queued', task: 'rerun' });
    expect(repo.reruns.get(job.id)).toEqual({
      step: 'refs',
      instructions: 'The reference starts with INV.',
    });
  });

  it('takes a model for a plugin that calls one', async () => {
    const { repo, job, rerun } = await seed({ uses: 'acme.ask@1', with: {} });
    expect((await rerun({ model: 'fast' })).statusCode).toBe(200);
    expect(repo.reruns.get(job.id)).toEqual({ step: 'refs', model: 'fast' });
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'awaiting_review' });
    const bad = await rerun({ model: 'nope' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('unknown model choice nope');
  });

  it.each([
    [
      {},
      { model: 'fast' },
      'text.pattern@1 calls no model: a re-run of step "refs" can\'t use one',
    ],
    [
      { uses: 'acme.magic@3' },
      { model: 'fast' },
      'step "refs": no plugin acme.magic@3 on this deployment\'s workers',
    ],
    [{}, { pageImages: [1] }, 'page images are for extract steps; "refs" is a plugin step'],
  ])('refuses %j with %j', async (plugin, payload, error) => {
    const { repo, job, rerun } = await seed(plugin);
    const res = await rerun(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(error);
    expect(repo.jobs.get(job.id)!.status).toBe('awaiting_review');
  });

  it("refuses while the plugin step's outputs have reviewer edits", async () => {
    const { repo, job, rerun } = await seed();
    await repo.addEdit(job.id, {
      field: 'reference',
      table: null,
      row: null,
      column: null,
      oldValue: 'a',
      newValue: 'b',
      editor: null,
      reason: null,
    });
    const res = await rerun({});
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('reviewer edits');
  });
});

describe('re-running a step of an enriched table (P4)', () => {
  const enrich = JSON.parse(
    readFileSync(
      new URL('../../../packages/shared/test/fixtures/enrich-steps.json', import.meta.url),
      'utf8',
    ),
  ) as { base: Record<string, unknown>; cases: { pipeline: Record<string, unknown>[] }[] };

  async function seed() {
    const c = await testApp({ plugins: new MemoryPluginCatalogue(catalogue.plugins) });
    await c.templates.create(
      'stability',
      1,
      { ...enrich.base, pipeline: enrich.cases[0]!.pipeline },
      'published',
    );
    const documentId = randomUUID();
    const job = await c.repo.createDocumentAndJob(
      {
        id: documentId,
        filename: 'report.pdf',
        sha256: 'x',
        sizeBytes: 1,
        specId: 'stability',
        specVersion: 1,
        bucket: 'inbox',
        objectKey: `stability/v1/${documentId}.pdf`,
      },
      null,
    );
    c.repo.jobs.set(job.id, { ...c.repo.jobs.get(job.id)!, status: 'awaiting_review' });
    await c.repo.addEdit(job.id, {
      field: null,
      table: 'lines',
      row: 1,
      column: 'qty',
      oldValue: 1,
      newValue: 2,
      editor: null,
      reason: null,
    });
    const rerun = (step: string) =>
      c.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/steps/${step}/rerun`, payload: {} });
    return { ...c, rerun };
  }

  it('refuses the creating step while any cell of its table was edited', async () => {
    const { rerun } = await seed();
    const res = await rerun('rows');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('reviewer edits');
  });

  it('lets an enriching step run while only other columns were edited', async () => {
    const { rerun } = await seed();
    expect((await rerun('expiry')).statusCode).toBe(200);
  });
});
