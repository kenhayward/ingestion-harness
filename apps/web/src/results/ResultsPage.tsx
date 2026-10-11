import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResultSummary } from '@ih/shared';
import type { Api } from '../api/client.js';

/** Must match the API's default `limit` for GET /api/results. */
export const RESULTS_PAGE_SIZE = 50;

const when = (iso: string) => new Date(iso).toLocaleString();

function reviewedBy(r: ResultSummary): string {
  if (!r.reviewedAt) return 'auto';
  return r.reviewer ?? 'unnamed reviewer';
}

export function ResultsPage({ api }: { api: Api }) {
  const [types, setTypes] = useState<{ id: string; title: string }[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [rows, setRows] = useState<ResultSummary[]>([]);
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

  const load = useCallback(
    async (cursor?: { before: string; beforeId: string }) => {
      const request = ++latest.current;
      setLoading(true);
      try {
        const page = await api.listResults({ templateId: templateId || undefined, ...cursor });
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
    [api, templateId],
  );

  useEffect(() => {
    setRows([]);
    setHasMore(false);
    void load();
  }, [load]);

  return (
    <section className="results">
      <h2>Results</h2>
      <label className="filter">
        Document type
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">All</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">Failed to load results: {error}</p>}
      {loaded && !error && rows.length === 0 ? (
        <p>
          {templateId
            ? 'No published results for this document type.'
            : 'No published results yet. Test runs and rejected documents never appear here.'}
        </p>
      ) : (
        <table aria-label="Published results">
          <thead>
            <tr>
              <th>Document</th>
              <th>Type</th>
              <th>Published</th>
              <th>Reviewed by</th>
              <th>Issues</th>
              <th>Files</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.jobId}>
                <td>
                  <a href={`#/results/${r.jobId}`}>{r.filename}</a>
                </td>
                <td>
                  {r.specId} v{r.specVersion}
                </td>
                <td>{when(r.publishedAt)}</td>
                <td>{reviewedBy(r)}</td>
                <td>{r.issueCount ?? '—'}</td>
                <td>{r.outputCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
    </section>
  );
}
