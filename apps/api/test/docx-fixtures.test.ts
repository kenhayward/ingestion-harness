import { afterEach, describe, expect, it, vi } from 'vitest';
import { docx } from './docx-fixtures.js';

describe('docx fixture', () => {
  afterEach(() => vi.useRealTimers());

  it('builds the same bytes whenever it is called', () => {
    // A zip stamps each entry with a time (2 s resolution); two calls either side of a tick must
    // still be one file, or "the same sample twice" tests see two different hashes.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T21:00:00Z'));
    const first = docx();
    vi.setSystemTime(new Date('2026-10-13T21:00:05Z'));
    expect(docx().equals(first)).toBe(true);
  });
});
