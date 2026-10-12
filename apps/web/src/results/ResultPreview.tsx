import { useEffect, useState } from 'react';
import type { ResultDetail, ResultSummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { shortWhen } from './format.js';
import { DOCUMENT_ERRORS, format } from './ResultDetail.js';

/** Rows of the first table shown in the preview (the full result shows them all). */
export const PREVIEW_TABLE_ROWS = 3;

const label = (c: { id: string; name?: string }) => c.name ?? c.id;

/**
 * Result preview (UI handoff §3): what was published for the selected row, without leaving the
 * list. The header renders from the list row at once; fields and rows come from getResult.
 */
export function ResultPreview({
  api,
  summary,
  typeTitle = summary.specId,
}: {
  api: Api;
  summary: ResultSummary;
  /** The document type's title (the list knows it); falls back to its id. */
  typeTitle?: string;
}) {
  const [detail, setDetail] = useState<ResultDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    api.getResult(summary.jobId).then(
      (d) => {
        if (!cancelled) setDetail(d);
      },
      (err: Error) => {
        if (!cancelled) setError(err.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, summary.jobId]);

  const reviewed = summary.reviewedAt
    ? `reviewed by ${summary.reviewer ?? 'unnamed reviewer'}`
    : 'auto-approved';
  const definition = detail?.definition;
  const document = detail?.document;
  const table = definition?.kind === 'template' ? definition.tables[0] : undefined;
  const rows = (table && document?.tables[table.id]) ?? [];

  return (
    <aside className="result-preview" aria-label="Result preview">
      <p className="eyebrow">Preview</p>
      <h2>{summary.filename}</h2>
      <p className="muted">
        {typeTitle} v{summary.specVersion} · published {shortWhen(summary.publishedAt)} · {reviewed}
      </p>
      {error && <p className="error">Couldn't load the preview: {error}</p>}
      {detail?.documentError && <p className="error">{DOCUMENT_ERRORS[detail.documentError]}.</p>}
      {definition && definition.kind !== 'template' && (
        <p className="muted">No preview for this document type.</p>
      )}
      {definition?.kind === 'template' && !document && !detail?.documentError && (
        <p className="muted">No published document to preview.</p>
      )}
      {definition?.kind === 'template' && document && (
        <>
          <dl className="meta preview-fields" aria-label="Fields" role="list">
            {definition.fields.map((f) => (
              <div key={f.id} role="listitem">
                <dt>{label(f)}</dt>
                <dd>{format(document.fields[f.id]?.value ?? null)}</dd>
              </div>
            ))}
          </dl>
          {table && rows.length > 0 && (
            <div className="preview-table">
              <p className="eyebrow">
                {label(table)} · first {Math.min(rows.length, PREVIEW_TABLE_ROWS)} rows
              </p>
              <table aria-label={label(table)}>
                <thead>
                  <tr>
                    {table.columns.map((c) => (
                      <th key={c.id}>{label(c)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, PREVIEW_TABLE_ROWS).map((r, i) => (
                    <tr key={i}>
                      {table.columns.map((c) => (
                        <td key={c.id}>{format(r[c.id] ?? null)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > PREVIEW_TABLE_ROWS && (
                <p className="muted">
                  Showing {PREVIEW_TABLE_ROWS} of {rows.length} rows
                </p>
              )}
            </div>
          )}
        </>
      )}
      <div className="panel-actions">
        <a className="button primary" href={`#/results/${summary.jobId}`}>
          Open full result
        </a>
        <a className="button" href={api.documentUrl(summary.jobId)} target="_blank" rel="noopener">
          View source PDF
        </a>
      </div>
    </aside>
  );
}
