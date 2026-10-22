import { describe, expect, it } from 'vitest';
import { pullTargets } from '../src/bridge/sync.js';
import { testApp } from './helpers.js';
import { FAKE_SINK } from './sink-targets-routes.test.js';

const letter = (publishTo: string) => ({
  id: 'letter',
  version: 1,
  name: 'Letter',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: { fields: [{ id: 'sender', type: 'text' }] },
  pipeline: [{ type: 'extract', id: 'head', fields: ['sender'], sections: ['all'] }],
  delivery: { publishTo },
});

/** Recipe validation names the cached targets (the bridge's registry, cached here). */
describe('a recipe naming a publishing target, with targets on the bridge', () => {
  it('still blocks an unknown target and passes one on the bridge', async () => {
    const c = await testApp();
    const issues = async () =>
      (await c.app.inject('/api/templates/letter/versions/1')).json().issues as unknown[];
    await c.templates.create('letter', 1, letter('finance-lake'), 'draft');
    expect(await issues()).toEqual([
      {
        path: 'delivery.publishTo',
        message: 'no publishing target finance-lake on this deployment',
      },
    ]);
    const created = await c.app.inject({
      method: 'POST',
      url: '/api/publish-targets',
      payload: { label: 'Finance lake', kind: 'internal', bucket: 'finance-bucket' },
    });
    expect(created.statusCode).toBe(201);
    expect(c.bridge.targets.has('finance-lake')).toBe(true);
    await pullTargets({ targets: c.targets, bridge: c.bridge, log: c.app.log });
    expect(await issues()).toEqual([]);
  });
});

describe('a recipe naming an external sink target', () => {
  const recipe = (publishTo: string[], formats?: string[]) => ({
    ...letter('default'),
    ...(formats?.includes('rdf')
      ? {
          semantics: {
            prefixes: { ex: 'https://ex.example/v#' },
            document: { class: 'ex:Letter', iri: 'doc/{source}' },
            fields: { sender: { property: 'ex:sender' } },
          },
        }
      : {}),
    delivery: { publishTo, ...(formats ? { formats } : {}) },
  });
  async function withSinkTarget() {
    const c = await testApp();
    c.bridge.sinkViews = [FAKE_SINK];
    const created = await c.app.inject({
      method: 'POST',
      url: '/api/publish-targets',
      payload: {
        kind: 'sink',
        label: 'Fake target',
        sinkId: 'fake',
        destination: { space: 'reports', name: '{source.stem}' },
      },
    });
    expect(created.statusCode).toBe(201);
    const issues = async () =>
      (await c.app.inject('/api/templates/letter/versions/1')).json().issues as unknown[];
    return { c, issues };
  }

  it('may deliver to it beside an S3 target', async () => {
    const { c, issues } = await withSinkTarget();
    await c.templates.create('letter', 1, recipe(['default', 'fake-target']), 'draft');
    expect(await issues()).toEqual([]);
  });

  it('a graph recipe cannot name a sink that does not take the graph', async () => {
    const { c, issues } = await withSinkTarget();
    await c.templates.create(
      'letter',
      1,
      recipe(['default', 'fake-target'], ['csv', 'rdf']),
      'draft',
    );
    expect(await issues()).toContainEqual({
      path: 'delivery.publishTo',
      message: 'fake-target (Fake sink) does not take the graph (rdf)',
    });
  });

  it('still needs a files target: a sink target alone is not enough', async () => {
    const { c, issues } = await withSinkTarget();
    await c.templates.create('letter', 1, recipe(['fake-target']), 'draft');
    expect(await issues()).toEqual([
      { path: 'delivery.publishTo', message: 'needs a target with the files layout' },
    ]);
  });
});
