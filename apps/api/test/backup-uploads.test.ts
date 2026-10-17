import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { UploadView } from '@ih/shared';
import { BackupUploads } from '../src/backup/uploads.js';
import { MemoryObjectStore } from '../src/storage/object-store.js';
import { accessApp } from './helpers.js';

/** Parts of 4 bytes keep the tests small; the route tests use the real part size. */
const PART = 4;

async function setup() {
  const store = new MemoryObjectStore();
  const uploads = new BackupUploads({ store, bucket: 'backups', partBytes: PART });
  return { store, uploads };
}

const put = (u: BackupUploads, id: string, n: number, text: string) =>
  u.part(id, n, Readable.from([Buffer.from(text)]), text.length);

describe('BackupUploads', () => {
  it('parts arriving out of order complete', async () => {
    const { uploads, store } = await setup();
    const started = await uploads.start({ size: 10, fileName: 'a.ctbak' }, 'Admin');
    expect(started).toMatchObject({ size: 10, partBytes: PART, parts: 3, received: [] });
    await put(uploads, started.id, 2, 'ij');
    await put(uploads, started.id, 0, 'abcd');
    const view = await put(uploads, started.id, 1, 'efgh');
    expect(view.received).toEqual([0, 1, 2]);
    const { key } = await uploads.complete(started.id);
    expect(key).toBe(`uploads/${started.id}.ctbak`);
    expect((await store.get('backups', key))!.toString()).toBe('abcdefghij');
  });

  it('a re-sent part replaces the first', async () => {
    const { uploads, store } = await setup();
    const { id } = await uploads.start({ size: 6, fileName: 'a.ctbak' }, 'Admin');
    await put(uploads, id, 0, 'xxxx');
    await put(uploads, id, 0, 'abcd');
    await put(uploads, id, 1, 'ef');
    const { key } = await uploads.complete(id);
    expect((await store.get('backups', key))!.toString()).toBe('abcdef');
  });

  it('complete with a missing part is a 409 naming it', async () => {
    const { uploads } = await setup();
    const { id } = await uploads.start({ size: 10, fileName: 'a.ctbak' }, 'Admin');
    await put(uploads, id, 0, 'abcd');
    await put(uploads, id, 2, 'ij');
    await expect(uploads.complete(id)).rejects.toMatchObject({
      status: 409,
      message: 'parts missing: 1',
    });
  });

  it('a wrong-sized part is a 400', async () => {
    const { uploads } = await setup();
    const { id } = await uploads.start({ size: 10, fileName: 'a.ctbak' }, 'Admin');
    await expect(put(uploads, id, 0, 'abc')).rejects.toMatchObject({
      status: 400,
      message: 'part 0 must be 4 bytes',
    });
    await expect(put(uploads, id, 2, 'ijk')).rejects.toMatchObject({
      status: 400,
      message: 'part 2 must be 2 bytes',
    });
    await expect(put(uploads, id, 3, 'x')).rejects.toMatchObject({ status: 400 });
  });

  it('a new upload aborts the old one', async () => {
    const { uploads, store } = await setup();
    const first = await uploads.start({ size: 8, fileName: 'a.ctbak' }, 'Admin');
    await put(uploads, first.id, 0, 'abcd');
    const second = await uploads.start({ size: 8, fileName: 'b.ctbak' }, 'Admin');
    expect(await uploads.get(first.id)).toBeNull();
    expect((await uploads.get(second.id))?.received).toEqual([]);
    expect(await store.get('backups', `uploads/${first.id}.json`)).toBeNull();
    await expect(put(uploads, first.id, 1, 'efgh')).rejects.toMatchObject({ status: 404 });
  });

  it('a damaged state file reads as no upload, and the next start removes it', async () => {
    const { uploads, store } = await setup();
    await store.put('backups', 'uploads/bad.json', Buffer.from('{not json'), 'application/json');
    await store.put(
      'backups',
      'uploads/bad.ctbak',
      Buffer.from('half'),
      'application/octet-stream',
    );
    await store.put('backups', 'uploads/odd.json', Buffer.from('{"id":1}'), 'application/json');

    expect(await uploads.get('bad')).toBeNull();
    expect(await uploads.completedKey('bad')).toBeNull();
    await expect(put(uploads, 'bad', 0, 'abcd')).rejects.toMatchObject({ status: 404 });

    const started = await uploads.start({ size: 4, fileName: 'a.ctbak' }, 'Admin');
    expect(await store.get('backups', 'uploads/bad.json')).toBeNull();
    expect(await store.get('backups', 'uploads/bad.ctbak')).toBeNull();
    expect(await store.get('backups', 'uploads/odd.json')).toBeNull();
    expect(await uploads.get(started.id)).not.toBeNull();
  });
});

describe('backup upload routes', () => {
  it('uploads a file in parts and resumes after a lost connection', async () => {
    const store = new MemoryObjectStore();
    const uploads = new BackupUploads({ store, bucket: 'backups' });
    const { app, adminCookie, userCookie } = await accessApp({ backupUploads: uploads, store });
    const headers = { cookie: adminCookie };
    const start = await app.inject({
      method: 'POST',
      url: '/api/backup/uploads',
      headers,
      payload: { size: 5, fileName: 'x.ctbak' },
    });
    expect(start.statusCode).toBe(201);
    const view = start.json<UploadView>();
    expect(view.partBytes).toBe(67108864);
    expect(view.parts).toBe(1);

    const refused = await app.inject({
      method: 'PUT',
      url: `/api/backup/uploads/${view.id}/parts/0`,
      headers: { cookie: userCookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('hello'),
    });
    expect(refused.statusCode).toBe(403);

    const wrong = await app.inject({
      method: 'PUT',
      url: `/api/backup/uploads/${view.id}/parts/0`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('hel'),
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: 'part 0 must be 5 bytes' });

    const early = await app.inject({
      method: 'POST',
      url: `/api/backup/uploads/${view.id}/complete`,
      headers,
    });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toEqual({ error: 'parts missing: 0' });

    const put = await app.inject({
      method: 'PUT',
      url: `/api/backup/uploads/${view.id}/parts/0`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('hello'),
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<UploadView>().received).toEqual([0]);

    const resumed = await app.inject({ url: `/api/backup/uploads/${view.id}`, headers });
    expect(resumed.json<UploadView>().received).toEqual([0]);
    const missing = await app.inject({
      url: '/api/backup/uploads/00000000-0000-4000-8000-000000000000',
      headers,
    });
    expect(missing.statusCode).toBe(404);

    const done = await app.inject({
      method: 'POST',
      url: `/api/backup/uploads/${view.id}/complete`,
      headers,
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ key: `uploads/${view.id}.ctbak` });
    expect((await store.get('backups', done.json().key))!.toString()).toBe('hello');
  });
});
