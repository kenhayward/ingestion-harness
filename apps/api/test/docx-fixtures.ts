import { strToU8, zipSync, type Zippable } from 'fflate';

export const DOCX_MAIN =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const FIXED_MTIME = new Date('2020-01-01T00:00:00Z');

/** A paragraph of plain text (WordprocessingML). */
export const para = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

/**
 * A minimal Word package: `body` is the inside of `<w:body>`; `parts` adds entries (e.g. a
 * footer); `mainType` null leaves out [Content_Types].xml.
 */
export function docx(
  opts: { body?: string; parts?: Record<string, string>; mainType?: string | null } = {},
): Buffer {
  const { body = para('HEADER Acme') + para('Batch 42'), parts = {}, mainType = DOCX_MAIN } = opts;
  const files: Zippable = {
    'word/document.xml': strToU8(`<w:document ${W}><w:body>${body}</w:body></w:document>`),
  };
  if (mainType !== null) {
    files['[Content_Types].xml'] = strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/' +
        'content-types"><Override PartName="/word/document.xml" ' +
        `ContentType="${mainType}"/></Types>`,
    );
  }
  for (const [name, xml] of Object.entries(parts)) files[name] = strToU8(xml);
  // A fixed entry time: zipSync stamps the current time otherwise, so two calls could differ.
  return Buffer.from(zipSync(files, { mtime: FIXED_MTIME }));
}

/** A WordprocessingML part (header, footer, footnotes) holding `inner`. */
export const part = (root: string, inner: string) => `<w:${root} ${W}>${inner}</w:${root}>`;
