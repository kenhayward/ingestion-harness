import { describe, expect, it } from 'vitest';
import { pullTargets } from '../src/bridge/sync.js';
import { testApp } from './helpers.js';
import { FAKE_SINK } from './fake-sink.js';

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

describe('a recipe’s name patterns per target (delivery.settings)', () => {
  async function withSinkTarget(destination: Record<string, string> = { space: 'reports' }) {
    const c = await testApp();
    c.bridge.sinkViews = [FAKE_SINK];
    const created = await c.app.inject({
      method: 'POST',
      url: '/api/publish-targets',
      payload: { kind: 'sink', label: 'Fake target', sinkId: 'fake', destination },
    });
    expect(created.statusCode).toBe(201);
    const issuesFor = async (settings?: Record<string, Record<string, string>>) => {
      await c.templates.create(
        'letter',
        1,
        {
          ...letter('default'),
          delivery: { publishTo: ['default', 'fake-target'], ...(settings ? { settings } : {}) },
        },
        'draft',
      );
      const issues = (await c.app.inject('/api/templates/letter/versions/1')).json().issues as {
        path: string;
        message: string;
      }[];
      return issues.filter((i) => i.path === 'delivery.settings').map((i) => i.message);
    };
    return { c, issuesFor };
  }

  it('a required pattern field needs a pattern here or on the target', async () => {
    const { issuesFor } = await withSinkTarget();
    expect(await issuesFor()).toEqual([
      'fake-target: Name needs a name pattern (set one here, or on the target)',
    ]);
  });

  it('a pattern on the target is enough, and a good setting raises nothing', async () => {
    const onTarget = await withSinkTarget({ space: 'reports', name: '{source.stem}' });
    expect(await onTarget.issuesFor()).toEqual([]);
    const set = await withSinkTarget();
    expect(await set.issuesFor({ 'fake-target': { name: '{field:sender|source.stem}' } })).toEqual(
      [],
    );
  });

  it('names what is wrong with a setting', async () => {
    const cases: [Record<string, Record<string, string>>, string][] = [
      [{ elsewhere: { name: 'x' } }, 'settings for elsewhere: the recipe does not deliver to it'],
      [
        { 'fake-target': { space: 'x', name: 'n' } },
        'fake-target: space is not a name pattern of Fake sink',
      ],
      [
        { 'fake-target': { name: '{nope}' } },
        'fake-target.name: `{nope}`: unknown variable nope at 1',
      ],
      [
        { 'fake-target': { name: '{field:other}' } },
        'fake-target.name: {field:other} names no field of this recipe',
      ],
      [
        { default: { name: 'x' }, 'fake-target': { name: 'n' } },
        'default: an S3 target takes no name patterns',
      ],
    ];
    for (const [settings, message] of cases) {
      const { issuesFor } = await withSinkTarget();
      expect(await issuesFor(settings)).toContain(message);
    }
  });
});
