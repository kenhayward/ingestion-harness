import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkSource, DOCX_MIME } from '../src/uploads.js';
import { docx, para, part } from './docx-fixtures.js';

const ins = '<w:ins w:id="1" w:author="Ken"><w:r><w:t>new</w:t></w:r></w:ins>';
const del = '<w:del w:id="2" w:author="Ken"><w:r><w:delText>old</w:delText></w:r></w:del>';
const TRACKED =
  'the Word document has tracked changes: accept or reject them in Word, then upload again';
const NOT_A_SOURCE = 'file is not a PDF or Word document (.docx)';

describe('checkSource', () => {
  it.each([
    ['a PDF', Buffer.from('%PDF-1.7\n...'), 'pdf'],
    ['a .docx', docx(), 'docx'],
    [
      'a .docx with a comment',
      docx({ body: para('x') + '<w:commentRangeStart w:id="0"/>' }),
      'docx',
    ],
    [
      'a table border (w:insideH)',
      docx({ body: '<w:tblBorders><w:insideH w:val="single"/></w:tblBorders>' }),
      'docx',
    ],
    ['a move range marker alone', docx({ body: '<w:moveFromRangeStart w:id="3"/>' }), 'docx'],
  ])('accepts %s', (_, body, kind) => {
    expect(checkSource(body)).toMatchObject({ ok: true, kind });
  });

  it('reads the content types whatever the attribute order', () => {
    const swapped = docx({
      mainType: null,
      parts: {
        '[Content_Types].xml': `<Types><Override ContentType='${DOCX_MIME}.main+xml' PartName='/word/document.xml'/></Types>`,
      },
    });
    expect(checkSource(swapped)).toMatchObject({ ok: true, kind: 'docx' });
    const elsewhere = docx({
      mainType: null,
      parts: {
        '[Content_Types].xml': `<Types><Override PartName="/word/other.xml" ContentType="${DOCX_MIME}.main+xml"/></Types>`,
      },
    });
    expect(checkSource(elsewhere)).toMatchObject({ ok: false, code: 415 });
  });

  it('gives the content type and extension of each kind', () => {
    expect(checkSource(docx())).toEqual({
      ok: true,
      kind: 'docx',
      contentType: DOCX_MIME,
      ext: 'docx',
    });
    expect(checkSource(Buffer.from('%PDF-1.4'))).toEqual({
      ok: true,
      kind: 'pdf',
      contentType: 'application/pdf',
      ext: 'pdf',
    });
  });

  it.each([
    ['a .docm', docx({ mainType: 'application/vnd.ms-word.document.macroEnabled.main+xml' })],
    [
      'a .dotx',
      docx({
        mainType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
      }),
    ],
    [
      'a spreadsheet',
      docx({
        mainType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
      }),
    ],
    ['a ZIP without content types', docx({ mainType: null })],
    ['a truncated ZIP', docx().subarray(0, 60)],
    ['random bytes', randomBytes(2000)],
    ['an empty file', Buffer.alloc(0)],
    ['text', Buffer.from('hello')],
  ])('refuses %s (415)', (_, body) => {
    expect(checkSource(body)).toEqual({ ok: false, code: 415, error: NOT_A_SOURCE });
  });

  it.each([
    ['an insertion in the body', docx({ body: para('a') + `<w:p>${ins}</w:p>` })],
    ['a deletion in the body', docx({ body: `<w:p>${del}</w:p>` })],
    [
      'a move in a footer',
      docx({ parts: { 'word/footer1.xml': part('ftr', '<w:p><w:moveFrom w:id="4"/></w:p>') } }),
    ],
    [
      'an insertion in a header',
      docx({ parts: { 'word/header2.xml': part('hdr', `<w:p>${ins}</w:p>`) } }),
    ],
    [
      'an insertion in the footnotes',
      docx({ parts: { 'word/footnotes.xml': part('footnotes', `<w:p>${ins}</w:p>`) } }),
    ],
  ])('refuses tracked changes: %s (422)', (_, body) => {
    expect(checkSource(body)).toEqual({ ok: false, code: 422, error: TRACKED });
  });

  it('stops inflating past the cap (zip bomb)', () => {
    const bomb = docx({ body: para('A'.repeat(200_000)) });
    expect(bomb.length).toBeLessThan(10_000);
    expect(checkSource(bomb, { maxInflated: 100_000 })).toEqual({
      ok: false,
      code: 422,
      error: 'the Word document is too large to check (over 64 MiB unpacked)',
    });
    expect(checkSource(bomb)).toMatchObject({ ok: true, kind: 'docx' });
  });
});
