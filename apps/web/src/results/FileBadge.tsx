import { isWordDocument } from '../documents.js';

/** The kind of uploaded file, as a small coloured badge: PDF or DOCX. */
export function FileBadge({ contentType, large }: { contentType: string; large?: boolean }) {
  const word = isWordDocument(contentType);
  return (
    <span
      className={`file-badge ${word ? 'docx' : 'pdf'}${large ? ' large' : ''}`}
      aria-hidden="true"
    >
      {word ? 'DOCX' : 'PDF'}
    </span>
  );
}

/** Initials for a reviewer's name: "Ken Hayward" → "KH". */
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .join('')
    .slice(0, 2);
