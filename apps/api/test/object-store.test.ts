import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MemoryObjectStore } from '../src/storage/object-store.js';

describe('MemoryObjectStore deletes', () => {
  it('deletes one key and everything under a prefix (in that bucket only)', async () => {
    const s = new MemoryObjectStore();
    for (const key of ['j1/a.json', 'j1/pages/p1.jpg', 'j10/a.json']) {
      await s.put('runs', key, Buffer.from('x'), 'application/json');
    }
    await s.put('other', 'j1/a.json', Buffer.from('x'), 'application/json');
    expect(await s.deletePrefix('runs', 'j1/')).toBe(2);
    expect(await s.get('runs', 'j10/a.json')).not.toBeNull();
    expect(await s.get('other', 'j1/a.json')).not.toBeNull();
    await s.delete('runs', 'j10/a.json');
    await s.delete('runs', 'missing'); // no error
    expect(await s.get('runs', 'j10/a.json')).toBeNull();
  });
});

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

async function drain(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

describe('MemoryObjectStore streaming', () => {
  it('list pages through 2,500 keys under a prefix', async () => {
    const s = new MemoryObjectStore();
    for (let i = 0; i < 2500; i++) {
      await s.put('runs', `p/${String(i).padStart(4, '0')}`, Buffer.alloc(i % 7), 'x/y');
    }
    await s.put('runs', 'q/other', Buffer.from('z'), 'x/y');
    await s.put('other', 'p/elsewhere', Buffer.from('z'), 'x/y');
    const listed = await collect(s.list('runs', 'p/'));
    expect(listed).toHaveLength(2500);
    expect(listed[0]).toEqual({ key: 'p/0000', size: 0 });
    expect(listed[8]).toEqual({ key: 'p/0008', size: 1 });
    expect(await collect(s.list('runs'))).toHaveLength(2501);
  });

  it('getStream returns null for a missing key', async () => {
    expect(await new MemoryObjectStore().getStream('runs', 'nope')).toBeNull();
  });

  it('putStream stores the streamed bytes and content type', async () => {
    const s = new MemoryObjectStore();
    await s.putStream(
      'runs',
      'k',
      Readable.from([Buffer.from('he'), Buffer.from('llo')]),
      'text/plain',
    );
    const got = await s.getStream('runs', 'k');
    expect(got?.size).toBe(5);
    expect(got?.contentType).toBe('text/plain');
    expect((await drain(got!.body)).toString()).toBe('hello');
    expect((await s.get('runs', 'k'))?.toString()).toBe('hello');
  });

  it('multipart parts complete in part order whatever the upload order', async () => {
    const s = new MemoryObjectStore();
    const id = await s.createMultipart('runs', 'big', 'application/zip');
    const e2 = await s.uploadPart('runs', 'big', id, 2, Readable.from([Buffer.from('BB')]), 2);
    const e1 = await s.uploadPart('runs', 'big', id, 1, Readable.from([Buffer.from('AA')]), 2);
    expect(await s.get('runs', 'big')).toBeNull();
    await s.completeMultipart('runs', 'big', id, [
      { partNumber: 2, etag: e2 },
      { partNumber: 1, etag: e1 },
    ]);
    expect((await s.get('runs', 'big'))?.toString()).toBe('AABB');
    const aborted = await s.createMultipart('runs', 'gone', 'x/y');
    await s.uploadPart('runs', 'gone', aborted, 1, Readable.from([Buffer.from('q')]), 1);
    await s.abortMultipart('runs', 'gone', aborted);
    expect(await s.get('runs', 'gone')).toBeNull();
  });
});
