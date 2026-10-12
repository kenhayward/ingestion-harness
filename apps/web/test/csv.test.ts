import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/results/csv.js';

describe('parseCsv', () => {
  it.each([
    ['', []],
    [
      'a,b\n1,2\n',
      [
        ['a', 'b'],
        ['1', '2'],
      ],
    ],
    [
      'a,b\r\n1,2',
      [
        ['a', 'b'],
        ['1', '2'],
      ],
    ],
    ['a,\n', [['a', '']]],
    ['"x,y",z\n', [['x,y', 'z']]],
    ['"say ""hi""",1\n', [['say "hi"', '1']]],
    ['"line 1\nline 2",x\n', [['line 1\nline 2', 'x']]],
    [',,\n', [['', '', '']]],
    [
      String.fromCharCode(0xfeff) + 'a,b\n°C,2\n',
      [
        ['a', 'b'],
        ['°C', '2'],
      ],
    ], // UTF-8 BOM (Excel-friendly CSVs)
  ])('%j', (text, rows) => {
    expect(parseCsv(text)).toEqual(rows);
  });
});
