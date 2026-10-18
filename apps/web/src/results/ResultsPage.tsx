import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ResultShow, ResultSummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { dayLabel, plural, timeOf } from './format.js';
import { FileBadge, initials } from './FileBadge.js';
import { ResultPreview } from './ResultPreview.js';
import { HelpButton } from '../ui/Help.js';
import { Segmented } from '../ui/Segmented.js';

/** Must match the API's default `limit` for GET /api/results. */
export const RESULTS_PAGE_SIZE = 50;
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

/** Results (UI handoff §3): published outputs in the target, filtered on the server. */
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
  const [rows, setRows] = useState<ResultSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  /** Only the latest request may update the list (filter changes and Load more race). */
  const latest = useRef(0);
  const [error, setError] = useState<string | null>(null);

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

  const load = useCallback(
    async (cursor?: { before: string; beforeId: string }) => {
      const request = ++latest.current;
      setLoading(true);
      try {
        const page = await api.listResults({
          templateId: templateId || undefined,
          q: q || undefined,
          ...(show ? { show } : {}),
          ...cursor,
        });
        if (request !== latest.current) return;
        setRows((current) => (cursor ? [...current, ...page] : page));
        setHasMore(page.length === RESULTS_PAGE_SIZE);
        setError(null);
      } catch (err) {
        if (request === latest.current) setError((err as Error).message);
      } finally {
        if (request === latest.current) {
          setLoading(false);
          setLoaded(true);
        }
      }
    },
    [api, templateId, q, show],
  );

  // The current rows stay until the new page arrives (load replaces them): clearing first would
  // flash a false "No results" and remount the preview on every filter change.
  useEffect(() => {
    void load();
  }, [load]);

  const selected = rows.find((r) => r.jobId === selectedId) ?? rows[0] ?? null;
  const titleOf = (id: string) => types.find((t) => t.id === id)?.title ?? id;

  return (
    <div className="results-page">
      <div className="page-header">
        <div>
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
      <div className="toolbar results-toolbar">
        <span className="select-field">
          <label htmlFor={typeId}>Document type</label>
          <select id={typeId} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
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
        {loaded && !error && rows.length > 0 && (
          <span className="results-count muted">
            {plural(rows.length, 'result')}
            {hasMore ? ' so far' : ''}
          </span>
        )}
      </div>
      {error && <p role="alert">Failed to load results: {error}</p>}
      <div className="results-layout">
        <div className="results-main">
          {loaded && !error && rows.length === 0 ? (
            <p className="card results-empty">
              {q
                ? `No results match “${q}”.`
                : show
                  ? SHOWS.find((o) => o.value === show)!.empty
                  : templateId
                    ? 'No published results for this document type.'
                    : 'No published results yet. Test runs and rejected documents never appear here.'}
            </p>
          ) : (
            <div className="card results-list-card">
              <table className="result-list" aria-label="Published results">
                <thead>
                  <tr>
                    <th className="badge-col">
                      <span className="visually-hidden">Kind</span>
                    </th>
                    <th>Document</th>
                    <th>Reviewed by</th>
                    <th>Published</th>
                    <th>Issues</th>
                    <th>Files</th>
                    <th className="chev-col">
                      <span className="visually-hidden">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const day = dayLabel(r.publishedAt, now);
                    const newDay = i === 0 || dayLabel(rows[i - 1]!.publishedAt, now) !== day;
                    return (
                      <Fragment key={r.jobId}>
                        {newDay && (
                          <tr className="day-row">
                            <th scope="row" colSpan={7}>
                              {day}
                            </th>
                          </tr>
                        )}
                        <tr
                          className={r === selected ? 'selected' : undefined}
                          onClick={() => setSelectedId(r.jobId)}
                        >
                          <td className="badge-col">
                            <FileBadge contentType={r.contentType} />
                          </td>
                          <td className="doc-cell">
                            <button
                              type="button"
                              className="doc-button"
                              aria-label={`Show preview of ${r.filename}`}
                              aria-pressed={r === selected}
                              title={r.filename}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedId(r.jobId);
                              }}
                            >
                              <span className="doc-name">{r.filename}</span>
                              <span className="doc-type">
                                {titleOf(r.specId)} <span className="mono">v{r.specVersion}</span>
                              </span>
                            </button>
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
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              <div className="results-foot muted">
                {hasMore ? (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => {
                      const last = rows.at(-1);
                      if (last) void load({ before: last.publishedAt, beforeId: last.jobId });
                    }}
                  >
                    Load more
                  </button>
                ) : (
                  <span>Showing {plural(rows.length, 'result')} · newest first</span>
                )}
              </div>
            </div>
          )}
        </div>
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
