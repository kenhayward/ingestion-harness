import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PluginInfo } from '@ih/shared';
import { MemoryPluginCatalogue } from '../src/plugins/catalogue.js';
import { settingsProblems } from '../src/plugins/settings.js';
import { testApp } from './helpers.js';

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
    expect(res.json().map((p: PluginInfo) => p.ref)).toEqual(['acme.lines@2', 'text.pattern@1']);
    expect(res.json()[1]).toEqual(catalogue.plugins[0]);
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

  it('is not checked without a catalogue (unit tests of other routes)', async () => {
    const c = await testApp({ plugins: null });
    await c.templates.create('letter', 1, recipe({ uses: 'acme.magic@3' }), 'draft');
    expect(await issuesOf(c.app)).toEqual([]);
  });
});
