import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResultSummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { FilterChips } from '../ui/FilterChips.js';

/** Must match the API's default `limit` for GET /api/results. */
export const RESULTS_PAGE_SIZE = 50;
/** The file name filter is sent once typing pauses this long. */
export const FILTER_DEBOUNCE_MS = 250;

const when = (iso: string) => new Date(iso).toLocaleString();

function reviewedBy(r: ResultSummary): string {
  if (!r.reviewedAt) return 'auto-approved';
  return r.reviewer ?? 'unnamed reviewer';
}

/** Results (UI handoff §3): published outputs in the target, filtered on the server. */
export function ResultsPage({
  api,
  query = '',
}: {
  api: Api;
  /** Top-bar search: fills the file name filter. */
  query?: string;
}) {
  const [types, setTypes] = useState<{ id: string; title: string }[]>([]);
  const [templateId, setTemplateId] = useState('');
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
    api.listSpecs().then(
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
    [api, templateId, q],
  );

  useEffect(() => {
    setRows([]);
    setHasMore(false);
    void load();
  }, [load]);

  const selected = rows.find((r) => r.jobId === selectedId) ?? rows[0] ?? null;

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
      </div>
      <div className="toolbar">
        <FilterChips
          label="Filter by document type"
          value={templateId}
          onChange={setTemplateId}
          chips={[
            { value: '', label: 'All types' },
            ...types.map((t) => ({ value: t.id, label: t.title })),
          ]}
        />
        <input
          type="search"
          className="filter-field"
          aria-label="Filter by file name"
          placeholder="Filter by file name"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {error && <p role="alert">Failed to load results: {error}</p>}
      {loaded && !error && rows.length === 0 ? (
        <p>
          {q
            ? `No results match “${q}”.`
            : templateId
              ? 'No published results for this document type.'
              : 'No published results yet. Test runs and rejected documents never appear here.'}
        </p>
      ) : (
        <div className="list-box">
          <table className="result-list" aria-label="Published results">
            <thead>
              <tr>
                <th>Document</th>
                <th>Document type</th>
                <th>Published</th>
                <th>Reviewed by</th>
                <th>Issues</th>
                <th>Download</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.jobId} className={r === selected ? 'selected' : undefined}>
                  <td className="doc-cell">
                    <button
                      type="button"
                      className="doc-button"
                      aria-label={`Show preview of ${r.filename}`}
                      aria-pressed={r === selected}
                      onClick={() => setSelectedId(r.jobId)}
                    >
                      {r.filename}
                    </button>
                  </td>
                  <td>
                    {r.specId} v{r.specVersion}
                  </td>
                  <td className="muted">{when(r.publishedAt)}</td>
                  <td>{reviewedBy(r)}</td>
                  <td className={r.issueCount ? 'issues-count' : 'muted'}>
                    {r.issueCount ? r.issueCount : '—'}
                  </td>
                  <td className="downloads-cell">
                    {r.outputs.map((o) => (
                      <a
                        key={o.outputId}
                        className="dl"
                        href={api.outputUrl(r.jobId, o.outputId, { stage: 'published' })}
                        aria-label={`Download ${o.name} for ${r.filename}`}
                        title={o.name}
                      >
                        {o.format.toUpperCase()}
                      </a>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasMore && (
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
      )}
    </div>
  );
}
