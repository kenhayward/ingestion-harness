import { describe, expect, it } from 'vitest';
import { mirrorTargets } from '../src/bridge/mirror.js';
import { testApp } from './helpers.js';

const letter = (publishTo: string) => ({
  id: 'letter',
  version: 1,
  name: 'Letter',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: { fields: [{ id: 'sender', type: 'text' }] },
  pipeline: [{ type: 'extract', id: 'head', fields: ['sender'], sections: ['all'] }],
  delivery: { publishTo },
});

/** Recipe validation still names CT Studio's targets (the registry the bridge mirrors). */
describe('a recipe naming a publishing target, with targets mirrored to the bridge', () => {
  it('still blocks an unknown target and passes a mirrored one', async () => {
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
    await mirrorTargets({ targets: c.targets, bridge: c.bridge });
    expect(c.bridge.targets.has('finance-lake')).toBe(true);
    expect(await issues()).toEqual([]);
  });
});
