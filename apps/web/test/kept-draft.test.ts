import { describe, expect, it, vi } from 'vitest';
import { keepDraft, loadKept, stringRecord } from '../src/ui/keptDraft.js';

const text = (v: unknown) => (typeof v === 'string' ? v : null);

describe('kept drafts (unsaved edits in this browser)', () => {
  it('keeps a value with its base, and forgets it', () => {
    keepDraft('ih.test', { base: 3, value: 'hello' });
    expect(loadKept('ih.test', text)).toEqual({ base: 3, value: 'hello' });
    keepDraft('ih.test', null);
    expect(loadKept('ih.test', text)).toBeNull();
  });

  it.each([
    ['not JSON', '{oops'],
    ['a bad base', JSON.stringify({ base: {}, value: 'x' })],
    ['a value the screen cannot use', JSON.stringify({ base: null, value: 42 })],
  ])('reads nothing from %s', (_, raw) => {
    localStorage.setItem('ih.test', raw);
    expect(loadKept('ih.test', text)).toBeNull();
  });

  it('carries on when storage is blocked', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    expect(() => keepDraft('ih.test', { base: null, value: 'x' })).not.toThrow();
    expect(loadKept('ih.test', text)).toBeNull();
    get.mockRestore();
    set.mockRestore();
  });

  it.each([
    [
      { a: 'x', b: '' },
      { a: 'x', b: '' },
    ],
    [{ a: 1 }, null],
    [['x'], null],
    [null, null],
  ])('stringRecord(%j)', (value, expected) => {
    expect(stringRecord(value)).toEqual(expected);
  });
});
