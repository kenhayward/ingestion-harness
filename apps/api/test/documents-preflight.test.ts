import { describe, expect, it } from 'vitest';
import { FAKE_SINK } from './fake-sink.js';
import { testApp } from './helpers.js';

async function setup() {
  const c = await testApp();
  c.bridge.sinkViews = [FAKE_SINK];
  await c.app.inject({
    method: 'POST',
    url: '/api/publish-targets',
    payload: {
      kind: 'sink',
      label: 'Fake target',
      sinkId: 'fake',
      destination: { space: 'reports', name: '{source.stem}' },
    },
  });
  await c.templates.create(
    'letter',
    1,
    {
      id: 'letter',
      version: 1,
      name: 'Letter',
      document: { sections: [{ id: 'all', anchor: '\\A' }] },
      outputs: { fields: [{ id: 'sender', type: 'text' }] },
      pipeline: [{ type: 'extract', id: 'head', fields: ['sender'], sections: ['all'] }],
      delivery: { publishTo: ['default', 'fake-target'] },
    },
    'draft',
  );
  await c.templates.publish('letter', 1, 'Ken');
  return c;
}

describe('POST /api/documents/preflight', () => {
  it("names the targets the uploader can't be delivered as, asking as the uploader", async () => {
    const c = await setup();
    c.bridge.preflightProblems = {
      'fake-target': {
        class: 'needs_user',
        code: 'connection_missing',
        message: 'admin has no connection for Fake target: add one on the connections page',
      },
    };
    const res = await c.app.inject({
      method: 'POST',
      url: '/api/documents/preflight',
      payload: { specId: 'letter' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      problems: [
        {
          targetLabel: 'Fake target',
          message: 'admin has no connection for Fake target: add one on the connections page',
        },
      ],
    });
    expect(c.bridge.preflights).toEqual([
      {
        targets: ['default', 'fake-target'],
        actingUser: { id: 'unit-test-admin', name: 'admin', email: null },
      },
    ]);
  });

  it("leaves out problems a connection can't fix (a sink that is down)", async () => {
    const c = await setup();
    c.bridge.preflightProblems = {
      'fake-target': { class: 'retryable', code: 'sink_unavailable', message: 'down' },
    };
    const res = await c.app.inject({
      method: 'POST',
      url: '/api/documents/preflight',
      payload: { specId: 'letter' },
    });
    expect(res.json()).toEqual({ problems: [] });
  });

  it('never depends on the bridge: down, it answers no problems', async () => {
    const c = await setup();
    c.bridge.failNext = new Error('connect ECONNREFUSED');
    const res = await c.app.inject({
      method: 'POST',
      url: '/api/documents/preflight',
      payload: { specId: 'letter' },
    });
    expect(res.json()).toEqual({ problems: [] });
  });

  it('asks nothing for a recipe with no sink target, or an unknown type', async () => {
    const c = await setup();
    for (const specId of ['tdemo', 'nosuch']) {
      const res = await c.app.inject({
        method: 'POST',
        url: '/api/documents/preflight',
        payload: { specId },
      });
      expect(res.json()).toEqual({ problems: [] });
    }
    expect(c.bridge.preflights).toEqual([]);
  });
});
