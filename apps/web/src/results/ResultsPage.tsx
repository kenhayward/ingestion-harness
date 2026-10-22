import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { ResultShow, ResultSummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { dayLabel, plural, timeOf } from './format.js';
import { FileBadge, initials } from './FileBadge.js';
import { ResultPreview } from './ResultPreview.js';
import { HelpButton } from '../ui/Help.js';
import { Segmented } from '../ui/Segmented.js';
import { usePageSize } from '../jobs/usePageSize.js';
import { layOutPage } from './paging.js';
import { ResultsPager } from './ResultsPager.js';

/** Lines a page holds (day headings included) until the list's height is measured. */
export const FALLBACK_PAGE_SIZE = 25;

/** Where a page starts: just older than the last result of the page before (none: the newest). */
type Cursor = { before: string; beforeId: string };
/** The file name filter is sent once typing pauses this long. */
export const FILTER_DEBOUNCE_MS = 250;

/** Who approved a result, as the list and preview show it. */
export function Reviewer({ r }: { r: Pick<ResultSummary, 'reviewer' | 'reviewedAt'> }) {
  if (!r.reviewedAt) return <span className="reviewer auto">Auto-approved</span>;
  const name = r.reviewer ?? 'Unnamed reviewer';
  return (
    <span className="reviewer">
      {r.reviewer && (
        <span className="avatar-initials" aria-hidden="true">
          {initials(r.reviewer)}
        </span>
      )}
      <span>{name}</span>
    </span>
  );
}

const SHOWS: { value: ResultShow | ''; label: string; empty: string }[] = [
  { value: '', label: 'All', empty: '' },
  { value: 'reviewed', label: 'Reviewed', empty: 'No reviewed results.' },
  { value: 'auto', label: 'Auto-approved', empty: 'No auto-approved results.' },
  { value: 'issues', label: 'With issues', empty: 'No published results with issues.' },
];

/**
 * Results (UI handoff §3): published outputs in the target, filtered and paged on the server.
 *
 * One line a result, grouped under day headings, beside the preview. From 1,000 px the page
 * fits the window: a page holds as many lines as the list's box (`usePageSize`), headings
 * counted (`layOutPage`), so the page never scrolls. The API pages from the last result shown
 * (`before`/`beforeId`): ‹ Newer goes back through the pages read. ↑/↓ move the selection (across
 * pages), Page Up/Down change page, Enter opens the selected result.
 */
export function ResultsPage({
  api,
  query = '',
  now,
}: {
  api: Api;
  /** Top-bar search: fills the file name filter. */
  query?: string;
  /** For tests: the time the day headings (Today, Yesterday) are counted from. */
  now?: number;
}) {
  const typeId = useId();
  const [types, setTypes] = useState<{ id: string; title: string }[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [show, setShow] = useState<ResultShow | ''>('');
  /** What's typed in the file name field, and what was last sent (after the pause). */
  const [filter, setFilter] = useState(query);
  const [q, setQ] = useState(query.trim());
  const { box: listBox, size: lines } = usePageSize<HTMLDivElement>(
    FALLBACK_PAGE_SIZE,
    'tbody tr.result-row',
  );
  /** Where this page starts, and the pages read before it (their start and how many they showed). */
  const [cursor, setCursor] = useState<Cursor | undefined>(undefined);
  const [trail, setTrail] = useState<{ cursor: Cursor | undefined; shown: number }[]>([]);
  /** The page's results as fetched (`lines` of them; the ones that don't fit are left over). */
  const [fetched, setFetched] = useState<ResultSummary[]>([]);
  /** The start `fetched` answers: a keyboard move to another page waits for it. */
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** Only the latest request may update the list (filter changes and paging race). */
  const latest = useRef(0);
  const [error, setError] = useState<string | null>(null);
  /** A keyboard move to another page: select its first or last result once it has loaded. */
  const [pick, setPick] = useState<'first' | 'last' | null>(null);
  /** A row to focus once it is drawn. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    // Retired types too: old jobs and results keep their names.
    api.listSpecs({ retired: 'include' }).then(
      (specs) => {
        const byId = new Map(specs.map((s) => [s.id, s.title]));
        setTypes(
          [...byId]
            .map(([id, title]) => ({ id, title }))
            .sort((a, b) => a.title.localeCompare(b.title)),
        );
      },
      () => setTypes([]),
    );
  }, [api]);

  // The top-bar search drives the same filter.
  useEffect(() => setFilter(query), [query]);
  useEffect(() => {
    const timer = setTimeout(() => setQ(filter.trim()), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filter]);
  // Another view starts on its first page.
  useEffect(() => {
    setCursor(undefined);
    setTrail([]);
  }, [templateId, q, show]);

  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      const page = await api.listResults({
        templateId: templateId || undefined,
        q: q || undefined,
        ...(show ? { show } : {}),
        limit: lines,
        ...cursor,
      });
      if (request !== latest.current) return;
      setFetched(page);
      setFetchedAt(JSON.stringify(cursor ?? null));
      setError(null);
    } catch (err) {
      if (request === latest.current) setError((err as Error).message);
    } finally {
      if (request === latest.current) setLoaded(true);
    }
  }, [api, templateId, q, show, lines, cursor]);

  // The current rows stay until the new page arrives (load replaces them): clearing first would
  // flash a false "No results" and remount the preview on every filter change.
  useEffect(() => {
    void load();
  }, [load]);

  const dayOf = (r: ResultSummary) => dayLabel(r.publishedAt, now);
  const page = layOutPage(fetched, lines, dayOf, cursor ? dayLabel(cursor.before, now) : null);
  const rows = fetched.slice(0, page.shown);
  const from = trail.reduce((n, t) => n + t.shown, 0);
  const hasNewer = trail.length > 0;
  const hasOlder = page.shown < fetched.length;

  const older = () => {
    const last = rows.at(-1);
    if (!hasOlder || !last) return;
    setTrail((t) => [...t, { cursor, shown: rows.length }]);
    setCursor({ before: last.publishedAt, beforeId: last.jobId });
  };
  const newer = () => {
    const back = trail.at(-1);
    if (!back) return;
    setTrail((t) => t.slice(0, -1));
    setCursor(back.cursor);
  };

  // A page reached from the keyboard selects its first or last result once it has loaded.
  const current = fetchedAt === JSON.stringify(cursor ?? null);
  useEffect(() => {
    if (!pick || !current || rows.length === 0) return;
    const target = pick === 'first' ? rows[0]! : rows[rows.length - 1]!;
    setPick(null);
    setSelectedId(target.jobId);
    setFocusId(target.jobId);
  }, [pick, current, rows]);
  useEffect(() => {
    if (!focusId) return;
    const button = section.current?.querySelector<HTMLElement>(
      `tr[data-job-id="${CSS.escape(focusId)}"] .doc-button`,
    );
    if (!button) return;
    button.focus();
    setFocusId(null);
  }, [focusId, fetched]);

  const selected = rows.find((r) => r.jobId === selectedId) ?? rows[0] ?? null;
  const titleOf = (id: string) => types.find((t) => t.id === id)?.title ?? id;

  const onListKey = (e: KeyboardEvent<HTMLElement>) => {
    const el = e.target as HTMLElement;
    const id = el.closest<HTMLElement>('.result-list tr')?.dataset.jobId;
    if (!id) return;
    const at = rows.findIndex((r) => r.jobId === id);
    if (at < 0) return;
    const select = (r: ResultSummary) => {
      setSelectedId(r.jobId);
      setFocusId(r.jobId);
    };
    const turn = (go: () => void, which: 'first' | 'last') => {
      go();
      setPick(which);
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (at < rows.length - 1) select(rows[at + 1]!);
      else if (hasOlder) turn(older, 'first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (at > 0) select(rows[at - 1]!);
      else if (hasNewer) turn(newer, 'last');
    } else if (e.key === 'PageDown' && hasOlder) {
      e.preventDefault();
      turn(older, 'first');
    } else if (e.key === 'PageUp' && hasNewer) {
      e.preventDefault();
      turn(newer, 'first');
    } else if (e.key === 'Enter' && el.classList.contains('doc-button')) {
      e.preventDefault();
      window.location.hash = `#/results/${id}`;
    }
  };

  const empty = loaded && !error && fetched.length === 0;

  return (
    <div className="results-page">
      <div className="page-header">
        <div className="results-title">
          <h1>Results</h1>
          <p className="muted">
            Published outputs in the target store. Test runs and rejected documents never appear
            here.
          </p>
        </div>
        <div className="page-header-actions">
          <HelpButton topic="results" />
        </div>
      </div>
      {error && <p role="alert">Failed to load results: {error}</p>}
      <div className="results-layout">
        <section
          className="results-main"
          aria-label="Result list"
          ref={section}
          onKeyDown={onListKey}
        >
          <div className="card results-list-card">
            <div className="toolbar results-toolbar">
              <span className="select-field">
                <label htmlFor={typeId} className="visually-hidden">
                  Document type
                </label>
                <select
                  id={typeId}
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                >
                  <option value="">All types</option>
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </span>
              <Segmented label="Show" options={SHOWS} value={show} onChange={setShow} />
              <span className="filter-search">
                <Icon name="search" />
                <input
                  type="search"
                  className="filter-field"
                  aria-label="Filter by file name"
                  maxLength={100}
                  placeholder="Filter by file name"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </span>
              <ResultsPager
                page={trail.length}
                hasNewer={hasNewer}
                hasOlder={hasOlder}
                onNewer={newer}
                onOlder={older}
              />
            </div>
            <div className="result-list-rows" ref={listBox}>
              {empty ? (
                <p className="results-empty">
                  {q
                    ? `No results match “${q}”.`
                    : show
                      ? SHOWS.find((o) => o.value === show)!.empty
                      : templateId
                        ? 'No published results for this document type.'
                        : 'No published results yet. Test runs and rejected documents never appear here.'}
                </p>
              ) : (
                <table className="result-list" aria-label="Published results">
                  <colgroup>
                    <col className="badge-col" />
                    <col />
                    <col className="type-col" />
                    <col className="reviewer-col" />
                    <col className="when-col" />
                    <col className="issues-col" />
                    <col className="files-col" />
                    <col className="chev-col" />
                  </colgroup>
                  <thead className="visually-hidden">
                    <tr>
                      <th>Kind</th>
                      <th>Document</th>
                      <th className="type-cell">Document type</th>
                      <th>Reviewed by</th>
                      <th>Published</th>
                      <th>Issues</th>
                      <th className="files-cell">Files</th>
                      <th>Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.lines.map((line) =>
                      line.kind === 'day' ? (
                        <tr key={`day-${line.day}`} className="day-row">
                          <th scope="row" colSpan={8}>
                            {line.day}
                            {line.continued && <span className="continued"> (continued)</span>}
                          </th>
                        </tr>
                      ) : (
                        <ResultRow
                          key={line.row.jobId}
                          r={line.row}
                          selected={line.row === selected}
                          typeTitle={titleOf(line.row.specId)}
                          onSelect={() => setSelectedId(line.row.jobId)}
                        />
                      ),
                    )}
                  </tbody>
                </table>
              )}
            </div>
            <div className="results-foot muted">
              <span className="keys-hint">
                <kbd>↑</kbd> <kbd>↓</kbd> select · <kbd>PgUp</kbd> <kbd>PgDn</kbd> page ·{' '}
                <kbd>Enter</kbd> open
              </span>
              <span>
                {rows.length > 0 ? `Showing ${from + 1}–${from + rows.length} · ` : ''}newest first
              </span>
            </div>
          </div>
        </section>
        {selected && (
          <ResultPreview
            key={selected.jobId}
            api={api}
            summary={selected}
            typeTitle={titleOf(selected.specId)}
          />
        )}
      </div>
    </div>
  );
}

/** One result on one line: kind, file, document type, reviewer, time, issues, files. */
function ResultRow({
  r,
  selected,
  typeTitle,
  onSelect,
}: {
  r: ResultSummary;
  selected: boolean;
  typeTitle: string;
  onSelect: () => void;
}) {
  const type = `${typeTitle} v${r.specVersion}`;
  return (
    <tr
      data-job-id={r.jobId}
      className={selected ? 'result-row selected' : 'result-row'}
      onClick={onSelect}
    >
      <td className="badge-col">
        <FileBadge contentType={r.contentType} />
      </td>
      <td className="doc-cell">
        <button
          type="button"
          className="doc-button"
          aria-label={`Show preview of ${r.filename}`}
          aria-pressed={selected}
          title={r.filename}
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
        >
          {r.filename}
        </button>
      </td>
      <td className="type-cell" title={type}>
        {typeTitle} <span className="mono">v{r.specVersion}</span>
      </td>
      <td>
        <Reviewer r={r} />
      </td>
      <td className="muted when-cell">{timeOf(r.publishedAt)}</td>
      <td>
        {r.issueCount ? (
          <span className="issues-count">
            <Icon name="warning" />
            <span>{r.issueCount}</span>
          </span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="muted files-cell">{plural(r.outputCount, 'file')}</td>
      <td className="chev-col" aria-hidden="true">
        ›
      </td>
    </tr>
  );
}
