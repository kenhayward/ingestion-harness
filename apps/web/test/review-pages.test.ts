import { describe, expect, it } from 'vitest';
import { isPageColumn, pageOf } from '../src/review/pages.js';

describe('isPageColumn', () => {
  it.each([
    [{ id: 'page' }, true],
    [{ id: 'page_no' }, true],
    [{ id: 'page_number' }, true],
    [{ id: 'pageNumber' }, true],
    [{ id: 'source_page' }, true],
    [{ id: 'pdf_page' }, true],
    [{ id: 'pages' }, true],
    [{ id: 'col3', name: 'Page' }, true],
    [{ id: 'col3', name: 'Page no.' }, true],
    [{ id: 'col3', name: 'Page #' }, true],
    [{ id: 'page_title' }, false],
    [{ id: 'pagination' }, false],
    [{ id: 'homepage' }, false],
    [{ id: 'batch', name: 'Batch' }, false],
  ])('%o → %s', (column, expected) => {
    expect(isPageColumn(column)).toBe(expected);
  });
});

describe('pageOf', () => {
  it.each([
    [14, 33, 14],
    ['14', 33, 14],
    ['p. 14', 33, 14],
    ['Page 14', 33, 14],
    ['14-15', 33, 14],
    [['14', '15'], 33, 14],
    [0, 33, null],
    [34, 33, null],
    [2.5, 33, null],
    ['n/a', 33, null],
    [null, 33, null],
    [true, 33, null],
  ])('%o of %d pages → %s', (value, pageCount, expected) => {
    expect(pageOf(value, pageCount)).toBe(expected);
  });
});
