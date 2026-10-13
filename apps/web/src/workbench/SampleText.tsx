import { useEffect, useState } from 'react';
import type { PreparedText } from '@ih/shared';
import type { Api } from '../api/client.js';

export type TextMark = { page: number; line: string; label: string; color?: string };

/** With page markers on, a section starting at a page top reports this line. */
const PAGE_MARKER = /^\[page \d+\]$/;

function PageBody({ text, marks }: { text: string; marks: Omit<TextMark, 'page'>[] }) {
  if (!marks.length) return <pre>{text}</pre>;
  const lines = text.split('\n');
  const used = new Set<string>();
  const usable = marks.filter((m) => m.line.trim() !== '');
  // Each mark lands on the first line equal to it, else the first line that starts with it.
  const landing = new Map<string, number>();
  for (const m of usable) {
    const wanted = m.line.trim();
    if (PAGE_MARKER.test(wanted)) {
      landing.set(m.label, 0);
      continue;
    }
    const exact = lines.findIndex((l) => l.trim() === wanted);
    const index = exact !== -1 ? exact : lines.findIndex((l) => l.trim().startsWith(wanted));
    if (index !== -1) landing.set(m.label, index);
  }
  return (
    <pre>
      {lines.map((line, i) => {
        const mark = usable.find((m) => !used.has(m.label) && landing.get(m.label) === i);
        if (mark) used.add(mark.label);
        return (
          <span key={i}>
            {mark && (
              <span
                role="note"
                aria-label={`${mark.label} starts here`}
                className="section-start"
                style={mark.color ? { background: mark.color } : undefined}
              >
                {`▶ ${mark.label} starts here\n`}
              </span>
            )}
            {line}
            {i < lines.length - 1 ? '\n' : ''}
          </span>
        );
      })}
    </pre>
  );
}

/** A sample's prepared text (after extraction and OCR), one region per page. */
export function SampleText({
  api,
  projectId,
  sampleId,
  marks,
  paged = false,
}: {
  api: Api;
  projectId: string;
  sampleId: string;
  /** Lines to flag with "<label> starts here" on the given page. */
  marks?: TextMark[];
  /** One page at a time with page chips (Samples preview); off: every page (Sections). */
  paged?: boolean;
}) {
  const [text, setText] = useState<PreparedText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    api.getSampleText(projectId, sampleId).then(setText, (err: Error) => setError(err.message));
  }, [api, projectId, sampleId]);

  if (error) return <p role="alert">{error}</p>;
  if (!text) return <p>Loading text…</p>;
  if (paged) {
    const current = text.pages.find((p) => p.number === page) ?? text.pages[0];
    return (
      <div className="sample-text paged">
        <div role="group" aria-label="Pages" className="page-chips">
          {text.pages.map((p) => (
            <button
              key={p.number}
              type="button"
              aria-pressed={p.number === current?.number}
              onClick={() => setPage(p.number)}
            >
              Page {p.number}
              {p.ocr && <span className="ocr-flag"> OCR</span>}
            </button>
          ))}
        </div>
        {current && (
          <section aria-label={`Page ${current.number}`}>
            <PageBody
              text={`[page ${current.number}]
${current.text}`}
              marks={(marks ?? []).filter((m) => m.page === current.number)}
            />
          </section>
        )}
      </div>
    );
  }
  return (
    <div className="sample-text">
      {text.pages.map((p) => (
        <section key={p.number} aria-label={`Page ${p.number}`}>
          <h4>
            Page {p.number}
            {p.ocr && <small className="badge"> OCR</small>}
          </h4>
          <PageBody text={p.text} marks={(marks ?? []).filter((m) => m.page === p.number)} />
        </section>
      ))}
    </div>
  );
}
