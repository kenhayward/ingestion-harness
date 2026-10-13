import type { MultipartFile } from '@fastify/multipart';
import { Unzip, UnzipInflate } from 'fflate';

const PDF_MAGIC = Buffer.from('%PDF-');
const ZIP_MAGIC = Buffer.from('PK\x03\x04', 'latin1');

export function isPdf(body: Uint8Array): boolean {
  return Buffer.from(body.buffer, body.byteOffset, Math.min(body.length, 5)).equals(PDF_MAGIC);
}

/** What an upload is (docs/design/word-documents.md): judged by its bytes, never its name. */
export type SourceKind = 'pdf' | 'docx';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const CONTENT_TYPES: Record<SourceKind, string> = {
  pdf: 'application/pdf',
  docx: DOCX_MIME,
};

export type SourceCheck =
  | { ok: true; kind: SourceKind; contentType: string; ext: SourceKind }
  | { ok: false; code: 415 | 422; error: string };

export const NOT_A_SOURCE = 'file is not a PDF or Word document (.docx)';
export const TRACKED_CHANGES =
  'the Word document has tracked changes: accept or reject them in Word, then upload again';
const TOO_LARGE = 'the Word document is too large to check (over 64 MiB unpacked)';

/** Inflated bytes the check reads at most, across the parts it inspects. */
const MAX_INFLATED = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const CHUNK = 16 * 1024;
const CONTENT_TYPES_PART = '[Content_Types].xml';
const DOCX_MAIN_TYPE = `${DOCX_MIME}.main+xml`;
const OVERRIDE = /<Override\s[^>]*>/g;
const attr = (tag: string, name: 'PartName' | 'ContentType') =>
  new RegExp(String.raw`\s${name}\s*=\s*["']([^"']*)["']`).exec(tag)?.[1];

/** /word/document.xml is declared a Word document, as the worker's `convert.is_docx` checks. */
function declaresDocx(types: string): boolean {
  return [...types.matchAll(OVERRIDE)].some(
    ([tag]) =>
      attr(tag, 'PartName') === '/word/document.xml' && attr(tag, 'ContentType') === DOCX_MAIN_TYPE,
  );
}
/** Parts whose text reaches the PDF: a tracked change in any of them would show as markup. */
const TEXT_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
/** Insertions, deletions and moves (not w:insideH, w:delText, w:moveFromRangeStart, …). */
const REVISION = /<w:(ins|del|moveFrom|moveTo)[\s/>]/;

const ok = (kind: SourceKind): SourceCheck => ({
  ok: true,
  kind,
  contentType: CONTENT_TYPES[kind],
  ext: kind,
});
const refuse = (code: 415 | 422, error: string): SourceCheck => ({ ok: false, code, error });

class TooLarge extends Error {}

/**
 * Whether an upload is a PDF or a .docx we accept: a .docx needs its main part declared as a
 * Word document (not .docm, .dotx or another OOXML package) and no tracked changes, whose
 * deleted text would show in the converted PDF. Only the inspected parts are inflated, and
 * inflating stops once `maxInflated` bytes have come out (sizes in the headers are never
 * trusted).
 */
export function checkSource(body: Uint8Array, opts: { maxInflated?: number } = {}): SourceCheck {
  if (isPdf(body)) return ok('pdf');
  const head = Buffer.from(body.buffer, body.byteOffset, Math.min(body.length, 4));
  if (!head.equals(ZIP_MAGIC)) return refuse(415, NOT_A_SOURCE);

  const maxInflated = opts.maxInflated ?? MAX_INFLATED;
  const parts = new Map<string, string>();
  let entries = 0;
  let inflated = 0;
  const unzip = new Unzip((file) => {
    if (++entries > MAX_ENTRIES) throw new Error('too many entries');
    if (file.name !== CONTENT_TYPES_PART && !TEXT_PART.test(file.name)) return;
    const chunks: Uint8Array[] = [];
    file.ondata = (err, data, final) => {
      if (err) throw err;
      inflated += data.length;
      if (inflated > maxInflated) throw new TooLarge();
      chunks.push(data);
      if (final) parts.set(file.name, Buffer.concat(chunks).toString('utf8'));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for (let at = 0; at < body.length; at += CHUNK) {
      unzip.push(body.subarray(at, at + CHUNK), false);
    }
    unzip.push(new Uint8Array(0), true);
  } catch (err) {
    if (err instanceof TooLarge) return refuse(422, TOO_LARGE);
    return refuse(415, NOT_A_SOURCE);
  }

  const types = parts.get(CONTENT_TYPES_PART);
  if (!types || !declaresDocx(types) || !parts.has('word/document.xml')) {
    return refuse(415, NOT_A_SOURCE);
  }
  for (const [name, xml] of parts) {
    if (name !== CONTENT_TYPES_PART && REVISION.test(xml)) return refuse(422, TRACKED_CHANGES);
  }
  return ok('docx');
}

/** A text field sent before the file part. */
export function multipartField(file: MultipartFile, name: string): string | undefined {
  const f = file.fields[name];
  const one = Array.isArray(f) ? f[0] : f;
  return one && one.type === 'field' ? String(one.value) : undefined;
}
