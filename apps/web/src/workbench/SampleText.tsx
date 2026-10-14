import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { PreparedText } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';

export type TextMark = { page: number; line: string; label: string; color?: string };

/** With page markers on, a section starting at a page top reports this line. */
const PAGE_MARKER = /^\[page \d+\]$/;

/** Samples preview: wrap long lines. */
const WRAP_STYLE = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;
/** Sections panel: indentation matters when an anchor misses, so never wrap it away; scroll. */
const SCROLL_STYLE = { whiteSpace: 'pre', overflowX: 'auto' } as const;

function PageBody({
  text,
  marks,
  wrap,
}: {
  text: string;
  marks: Omit<TextMark, 'page'>[];
  wrap: boolean;
}) {
  const PRE_STYLE = wrap ? WRAP_STYLE : SCROLL_STYLE;
  if (!marks.length) return <pre style={PRE_STYLE}>{text}</pre>;
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
    <pre style={PRE_STYLE}>
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
  focus,
}: {
  api: Api;
  projectId: string;
  sampleId: string;
  /** Lines to flag with "<label> starts here" on the given page. */
  marks?: TextMark[];
  /** A mark label to scroll into view once the text is shown. */
  focus?: string;
  /** One page at a time with a pager (Samples preview); off: every page (Sections). */
  paged?: boolean;
}) {
  const [text, setText] = useState<PreparedText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPage(1); // another sample opens on its first page
    api.getSampleText(projectId, sampleId).then(setText, (err: Error) => setError(err.message));
  }, [api, projectId, sampleId]);

  useEffect(() => {
    if (!text || !focus) return;
    const notes = root.current?.querySelectorAll('[role="note"]') ?? [];
    const wanted = `${focus} starts here`;
    for (const note of notes) {
      if (note.getAttribute('aria-label') === wanted) {
        note.scrollIntoView?.({ block: 'nearest' });
        return;
      }
    }
  }, [text, focus, page]);

  if (error) return <p role="alert">{error}</p>;
  if (!text) return <p>Loading text…</p>;
  if (paged) {
    const total = text.pages.length;
    const current = text.pages.find((p) => p.number === page) ?? text.pages[0];
    const n = current?.number ?? 1;
    const go = (to: number) => setPage(Math.min(Math.max(to, 1), total));
    // ← and → turn pages while focus is in the panel (never while typing in a field).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowLeft' && n > 1) go(n - 1);
      else if (e.key === 'ArrowRight' && n < total) go(n + 1);
      else return;
      e.preventDefault();
    };
    return (
      <div className="sample-text paged" ref={root} onKeyDown={onKeyDown}>
        <nav className="page-pager" aria-label="Pages">
          <span className="pager">
            <button
              type="button"
              aria-label="Previous page"
              disabled={n <= 1}
              onClick={() => go(n - 1)}
            >
              <Icon name="chevronLeft" />
            </button>
            <span className="pager-label" aria-live="polite">
              <strong>Page {n}</strong> <span className="muted">of {total}</span>
            </span>
            <button
              type="button"
              aria-label="Next page"
              disabled={n >= total}
              onClick={() => go(n + 1)}
            >
              <Icon name="chevronRight" />
            </button>
          </span>
          {current?.ocr && (
            <span className="tag tone-info" title="This page was read by OCR">
              OCR
            </span>
          )}
        </nav>
        {current && (
          // Focusable so the keyboard can scroll a long page and turn pages with the arrows.
          <section aria-label={`Page ${current.number}`} tabIndex={0}>
            <PageBody
              text={`[page ${current.number}]
${current.text}`}
              marks={(marks ?? []).filter((m) => m.page === current.number)}
              wrap
            />
          </section>
        )}
      </div>
    );
  }
  return (
    <div className="sample-text" ref={root}>
      {text.pages.map((p) => (
        <section key={p.number} aria-label={`Page ${p.number}`}>
          <h4>
            Page {p.number}
            {p.ocr && <small className="badge"> OCR</small>}
          </h4>
          <PageBody
            text={p.text}
            marks={(marks ?? []).filter((m) => m.page === p.number)}
            wrap={false}
          />
        </section>
      ))}
    </div>
  );
}
