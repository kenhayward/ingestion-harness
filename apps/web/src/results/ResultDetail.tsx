import { useEffect, useState } from 'react';
import type {
  DocumentError,
  JobOutput,
  PublishedDocument,
  ResultDefinition,
  ResultDetail,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { display } from '../review/effective.js';
import { parseCsv } from './csv.js';

export const PREVIEW_ROWS = 500;

export const DOCUMENT_ERRORS: Record<DocumentError, string> = {
  'missing from target': 'The published document is missing from the target',
  'target storage unavailable': 'The target storage could not be reached',
  'invalid document': 'The published document in the target is not valid',
};

type Col = { id: string; name?: string };
type TableCols = { id: string; name?: string; columns: Col[] };

const label = (c: { id: string; name?: string }) => c.name ?? c.id;

const isObject = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function format(value: unknown): string {
  if (isObject(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return display(value.map((item) => (isObject(item) ? JSON.stringify(item) : item)));
  }
  return display(value);
}

/** Every key present in any row, in first-seen order (rows need not share a shape). */
function columnsOf(rows: Record<string, unknown>[]): string[] {
  return [...new Set(rows.flatMap((r) => Object.keys(r)))];
}

export function ResultDetailView({ api, jobId }: { api: Api; jobId: string }) {
  const [result, setResult] = useState<ResultDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getResult(jobId).then(setResult, (err: Error) => setError(err.message));
  }, [api, jobId]);

  const back = <a href="#/results">← Results</a>;
  if (error) {
    return (
      <section className="result-detail">
        {back}
        <p role="alert">{error}</p>
      </section>
    );
  }
  if (!result) return <p role="status">Loading…</p>;

  const { job, target, outputs, document, documentError, definition } = result;
  const review = job.reviewedAt
    ? `Approved by ${job.reviewer ?? 'unnamed reviewer'}${job.reviewNote ? ` — ${job.reviewNote}` : ''}`
    : 'Published without review';

  return (
    <section className="result-detail">
      {back}
      <h2>
        {job.filename}{' '}
        <small>
          {job.specId} v{job.specVersion}
        </small>
      </h2>
      <dl className="result-meta">
        <dt>Published</dt>
        <dd>{new Date(result.publishedAt).toLocaleString()}</dd>
        <dt>Review</dt>
        <dd>{review}</dd>
        <dt>Publishing target</dt>
        <dd>
          {target.label}{' '}
          <code>
            {target.bucket}/{target.prefix}
          </code>
        </dd>
      </dl>
      <nav aria-label="Downloads" className="downloads">
        {outputs.map((o) => (
          <a key={o.outputId} href={api.outputUrl(job.id, o.outputId, { stage: 'published' })}>
            {o.outputId}.{o.format}
          </a>
        ))}
      </nav>
      {documentError && (
        <p role="alert">{`${DOCUMENT_ERRORS[documentError]} (bucket ${target.bucket}).`}</p>
      )}
      {document ? (
        <DocumentView document={document} definition={definition} />
      ) : (
        !documentError && <OutputPreviews api={api} jobId={job.id} outputs={outputs} />
      )}
    </section>
  );
}

function DocumentView({
  document,
  definition,
}: {
  document: PublishedDocument;
  definition: ResultDefinition;
}) {
  const edits = document.review?.edits ?? [];
  const fields: Col[] =
    definition.kind === 'template'
      ? definition.fields
      : Object.keys(document.fields).map((id) => ({ id }));
  const tables: TableCols[] =
    definition.kind === 'template'
      ? definition.tables
      : Object.entries(document.tables).map(([id, rows]) => ({
          id,
          columns: columnsOf(rows).map((c) => ({ id: c })),
        }));
  const checks = Object.entries(document.checks);
  const issueColumns = ['step', 'target', 'row', 'column', 'raw', 'message'];

  return (
    <>
      {fields.length > 0 && (
        <section aria-label="Fields">
          <h3>Fields</h3>
          <dl className="result-fields">
            {fields.map((f) => (
              <div key={f.id}>
                <dt>{label(f)}</dt>
                <dd>
                  {format(document.fields[f.id]?.value)}
                  {edits.some((e) => e.field === f.id) && <small className="edited">edited</small>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {tables.map((t) => {
        const rows = document.tables[t.id] ?? [];
        return (
          <section key={t.id}>
            <h3>
              {label(t)} <small>({rows.length} rows)</small>
            </h3>
            <div className="table-scroll">
              <table aria-label={label(t)}>
                <thead>
                  <tr>
                    <th>#</th>
                    {t.columns.map((c) => (
                      <th key={c.id}>{label(c)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      {t.columns.map((c) => {
                        const edited = edits.some(
                          (e) => e.table === t.id && e.row === i + 1 && e.column === c.id,
                        );
                        return (
                          <td
                            key={c.id}
                            className={edited ? 'edited-cell' : undefined}
                            title={edited ? 'edited in review' : undefined}
                          >
                            {format(row[c.id])}
                            {edited && <small className="edited">edited</small>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      <details>
        <summary>Checks ({checks.length})</summary>
        {checks.map(([id, check]) => {
          const header = columnsOf(check.rows);
          return (
            <SimpleTable
              key={id}
              label={id}
              header={header}
              rows={check.rows.map((r) => header.map((k) => format(r[k])))}
            />
          );
        })}
      </details>
      <details>
        <summary>Issues ({document.issues.length})</summary>
        <SimpleTable
          label="Issues"
          header={issueColumns}
          rows={document.issues.map((i) => issueColumns.map((k) => format(i[k])))}
        />
      </details>
    </>
  );
}

function SimpleTable({
  label: name,
  header,
  rows,
}: {
  label: string;
  header: string[];
  rows: string[][];
}) {
  return (
    <div className="table-scroll">
      <table aria-label={name}>
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OutputPreviews({
  api,
  jobId,
  outputs,
}: {
  api: Api;
  jobId: string;
  outputs: JobOutput[];
}) {
  return (
    <>
      {outputs.map((o) => (
        <OutputPreview key={o.outputId} api={api} jobId={jobId} output={o} />
      ))}
    </>
  );
}

function OutputPreview({ api, jobId, output }: { api: Api; jobId: string; output: JobOutput }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const name = `${output.outputId}.${output.format}`;

  useEffect(() => {
    api
      .getOutputText(jobId, output.outputId, 'published')
      .then(setText, (err: Error) => setFailed(err.message));
  }, [api, jobId, output.outputId]);

  if (failed) return <p className="hint">{`${name}: ${failed}`}</p>;
  if (text === null) return <p role="status">Loading {name}…</p>;
  if (output.format === 'json') {
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Not JSON after all: show it raw.
    }
    return (
      <section>
        <h3>{name}</h3>
        <pre>{pretty}</pre>
      </section>
    );
  }
  const [header = [], ...body] = parseCsv(text);
  return (
    <section>
      <h3>{name}</h3>
      <SimpleTable label={name} header={header} rows={body.slice(0, PREVIEW_ROWS)} />
      {body.length > PREVIEW_ROWS && (
        <p className="hint">{`Showing ${PREVIEW_ROWS} of ${body.length} rows`}</p>
      )}
    </section>
  );
}
