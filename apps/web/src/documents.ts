import { DOCX_MIME } from '@ih/shared';

/**
 * What can be uploaded as a source document (docs/design/word-documents.md): a PDF or a Word
 * document (.docx). The API decides from the bytes; this only keeps other files out of the
 * pickers and upload lists.
 */
export const SOURCE_ACCEPT = ['application/pdf', '.pdf', '.docx', DOCX_MIME].join(',');

/** A PDF or .docx by type or name (browsers often send no type for .docx). */
export const isSourceFile = (f: File): boolean =>
  f.type === 'application/pdf' || f.type === DOCX_MIME || /\.(pdf|docx)$/i.test(f.name);

/** Whether a job's or result's document is a Word document (from its `contentType`). */
export const isWordDocument = (contentType: string): boolean => contentType === DOCX_MIME;
