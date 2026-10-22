import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampWidth,
  DEFAULT_LAYOUT,
  loadLayout,
  saveLayout,
  splitName,
} from '../src/review/layout.js';

beforeEach(() => localStorage.clear());

describe('review layout', () => {
  it.each([
    ['Test Parameters (Table IX)', 'Test Parameters', 'Table IX'],
    ['Storage Conditions (Tables VII & VIII)', 'Storage Conditions', 'Tables VII & VIII'],
    ['Batches', 'Batches', null],
    ['(only a reference)', '(only a reference)', null],
  ])('splits %s into its name and reference', (name, title, ref) => {
    expect(splitName(name)).toEqual({ title, ref });
  });

  it('keeps the divider between 20% and 80%', () => {
    expect(clampWidth(5)).toBe(20);
    expect(clampWidth(95)).toBe(80);
    expect(clampWidth(44.6)).toBe(45);
  });

  it('remembers the layout and reads a damaged one as the default, field by field', () => {
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
    saveLayout({ docWidth: 60, hidden: 'data', docSide: 'right' });
    expect(loadLayout()).toEqual({ docWidth: 60, hidden: 'data', docSide: 'right' });
    localStorage.setItem('ih.reviewLayout', '{"docWidth":"wide","hidden":"all","docSide":"up"}');
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
    localStorage.setItem('ih.reviewLayout', 'not json');
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });
});
