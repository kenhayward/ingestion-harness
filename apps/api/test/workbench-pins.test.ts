import { describe, expect, it } from 'vitest';
import { accessApp, testApp } from './helpers.js';

type App = Awaited<ReturnType<typeof testApp>>['app'];

const create = (app: App, id: string, cookie?: string) =>
  app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id, name: id },
    headers: cookie ? { cookie } : {},
  });

describe('Workbench pins', () => {
  it('lists pins most recent first', async () => {
    const { app } = await testApp();
    await create(app, 'alpha');
    await create(app, 'beta');
    expect((await app.inject({ method: 'PUT', url: '/api/workbench/pins/alpha' })).statusCode).toBe(
      204,
    );
    await app.inject({ method: 'PUT', url: '/api/workbench/pins/beta' });
    const res = await app.inject('/api/workbench/pins');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(['beta', 'alpha']);
  });

  it('keeps the original pinned time when re-pinning', async () => {
    const { app } = await testApp();
    await create(app, 'alpha');
    await create(app, 'beta');
    await app.inject({ method: 'PUT', url: '/api/workbench/pins/alpha' });
    await app.inject({ method: 'PUT', url: '/api/workbench/pins/beta' });
    await app.inject({ method: 'PUT', url: '/api/workbench/pins/alpha' });
    expect((await app.inject('/api/workbench/pins')).json()).toEqual(['beta', 'alpha']);
  });

  it('refuses to pin an unknown project', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'PUT', url: '/api/workbench/pins/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'project not found' });
  });

  it('unpins idempotently', async () => {
    const { app } = await testApp();
    await create(app, 'alpha');
    await app.inject({ method: 'PUT', url: '/api/workbench/pins/alpha' });
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'DELETE', url: '/api/workbench/pins/alpha' });
      expect(res.statusCode).toBe(204);
    }
    expect((await app.inject('/api/workbench/pins')).json()).toEqual([]);
  });

  it('drops a deleted project from the pins', async () => {
    const { app } = await testApp();
    await create(app, 'alpha');
    await app.inject({ method: 'PUT', url: '/api/workbench/pins/alpha' });
    await app.inject({ method: 'DELETE', url: '/api/workbench/projects/alpha' });
    expect((await app.inject('/api/workbench/pins')).json()).toEqual([]);
  });

  it('keeps pins per token', async () => {
    const { app, adminCookie, userCookie } = await accessApp();
    await create(app, 'alpha', adminCookie);
    await app.inject({
      method: 'PUT',
      url: '/api/workbench/pins/alpha',
      headers: { cookie: adminCookie },
    });
    const pins = async (cookie: string) =>
      (await app.inject({ url: '/api/workbench/pins', headers: { cookie } })).json();
    expect(await pins(adminCookie)).toEqual(['alpha']);
    expect(await pins(userCookie)).toEqual([]);
  });
});
