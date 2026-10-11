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
