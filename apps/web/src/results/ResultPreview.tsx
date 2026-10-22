import { useEffect, useState } from 'react';
import type { ResultDetail, ResultSummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { isWordDocument } from '../documents.js';
import { Icon } from '../ui/Icon.js';
import { plural, shortWhen } from './format.js';
import { FileBadge } from './FileBadge.js';
import { DOCUMENT_ERRORS, format } from './ResultDetail.js';

/** Rows of the first table shown in the preview (the full result shows them all). */
export const PREVIEW_TABLE_ROWS = 3;
/** Fields shown in the preview (the full result shows them all). */
export const PREVIEW_FIELDS = 6;
/** Published files listed in the preview (the full result lists them all). */
export const PREVIEW_FILES = 8;

const label = (c: { id: string; name?: string }) => c.name ?? c.id;

/**
 * Open full result, Open in viewer (a recipe result: the document beside its values, read-only),
 * the original (PDF in a tab, or the .docx), and the ZIP of every output.
 */
export function ResultActions({
  api,
  jobId,
  filename,
  contentType,
  outputCount,
  primary,
  viewer,
}: {
  api: Api;
  jobId: string;
  filename: string;
  contentType: string;
  outputCount: number;
  /** The preview leads with Open full result; the full result has no such link. */
  primary?: boolean;
  /** A recipe result, so the Review page can show it (it refuses legacy spec jobs). */
  viewer?: boolean;
}) {
  return (
    <div role="group" aria-label="Actions" className="result-actions">
      {primary && (
        <a
          className="button primary"
          href={`#/results/${jobId}`}
          aria-label={`Open full result for ${filename}`}
        >
          <Icon name="open" />
          Open full result
        </a>
      )}
      {viewer && (
        <a
          className="button"
          href={`#/review/${jobId}`}
          aria-label={`Open ${filename} in the viewer`}
          title="The document beside its values, with page thumbnails and the tables (read-only)"
        >
          <Icon name="eye" />
          Open in viewer
        </a>
      )}
      {isWordDocument(contentType) ? (
        <a
          className="button"
          href={api.documentUrl(jobId)}
          download
          aria-label={`Download original of ${filename}`}
          title="Download original (.docx)"
        >
          <Icon name="file" />
          Original
        </a>
      ) : (
        <a
          className="button"
          href={api.documentUrl(jobId)}
          target="_blank"
          rel="noopener"
          aria-label={`View PDF of ${filename}`}
          title="View PDF"
        >
          <Icon name="file" />
          PDF
        </a>
      )}
      <a
        className={primary ? 'button' : 'button primary'}
        href={api.archiveUrl(jobId)}
        aria-label={`Download ${filename} results as ZIP`}
        title={`Download all ${outputCount} files as one ZIP`}
      >
        <Icon name="download" />
        {primary ? 'ZIP' : 'Download all · ZIP'}
      </a>
    </div>
  );
}

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

  const definition = detail?.definition;
  const document = detail?.document;
  const table = definition?.kind === 'template' ? definition.tables[0] : undefined;
  const rows = (table && document?.tables[table.id]) ?? [];
  const fields = definition?.kind === 'template' ? definition.fields : [];

  return (
    <aside className="result-preview card" aria-label="Result preview">
      <div className="preview-head">
        <FileBadge contentType={summary.contentType} />
        <h2>{summary.filename}</h2>
      </div>
      <p className="preview-sub">
        <span className="kind-tag tone-info">
          {typeTitle} v{summary.specVersion}
        </span>
        <span>Published {shortWhen(summary.publishedAt)}</span>
        <span>
          ·{' '}
          {summary.reviewedAt
            ? `Reviewed by ${summary.reviewer ?? 'unnamed reviewer'}`
            : 'Auto-approved'}
        </span>
        {summary.issueCount !== null && (
          <span>· {summary.issueCount ? plural(summary.issueCount, 'issue') : 'No issues'}</span>
        )}
      </p>
      <ResultActions
        api={api}
        jobId={summary.jobId}
        filename={summary.filename}
        contentType={summary.contentType}
        outputCount={summary.outputCount}
        primary
        viewer={definition?.kind === 'template'}
      />
      {error && <p className="error">Couldn't load the preview: {error}</p>}
      {detail?.documentError && <p className="error">{DOCUMENT_ERRORS[detail.documentError]}.</p>}
      {definition && definition.kind !== 'template' && (
        <p className="muted">No preview for this document type.</p>
      )}
      {definition?.kind === 'template' && !document && !detail?.documentError && (
        <p className="muted">No published document to preview.</p>
      )}
      {definition?.kind === 'template' && document && fields.length > 0 && (
        <section className="preview-section">
          <p className="preview-section-head">
            <span className="eyebrow">Fields</span>
            {fields.length > PREVIEW_FIELDS && (
              <span className="muted">
                {PREVIEW_FIELDS} of {fields.length}
              </span>
            )}
          </p>
          <dl className="preview-fields" aria-label="Fields" role="list">
            {fields.slice(0, PREVIEW_FIELDS).map((f) => (
              <div key={f.id} role="listitem">
                <dt>{label(f)}</dt>
                <dd>{format(document.fields[f.id]?.value ?? null)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {definition?.kind === 'template' && document && table && rows.length > 0 && (
        <section className="preview-section">
          <p className="preview-section-head">
            <span className="eyebrow">
              {label(table)} ·{' '}
              {rows.length > PREVIEW_TABLE_ROWS
                ? `first ${PREVIEW_TABLE_ROWS} rows`
                : plural(rows.length, 'row')}
            </span>
          </p>
          <div className="preview-scroll">
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
                    {table.columns.map((c) => {
                      const text = format(r[c.id] ?? null);
                      return (
                        <td key={c.id} title={text}>
                          {text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > PREVIEW_TABLE_ROWS && (
            <p className="muted">
              Showing {PREVIEW_TABLE_ROWS} of {rows.length} rows
            </p>
          )}
        </section>
      )}
      {summary.outputs.length > 0 && (
        <section className="preview-section">
          <p className="preview-section-head">
            <span className="eyebrow">Published files · {summary.outputs.length}</span>
          </p>
          <ul className="preview-files" aria-label="Published files">
            {summary.outputs.slice(0, PREVIEW_FILES).map((o) => (
              <li key={o.outputId}>
                <span className="kind-tag tone-neutral">{o.format.toUpperCase()}</span>
                <span className="mono">{o.name}</span>
                {o.rowCount !== null && <span className="muted">{plural(o.rowCount, 'row')}</span>}
              </li>
            ))}
          </ul>
          {summary.outputs.length > PREVIEW_FILES && (
            <p className="muted">
              and {summary.outputs.length - PREVIEW_FILES} more in the full result
            </p>
          )}
        </section>
      )}
    </aside>
  );
}
