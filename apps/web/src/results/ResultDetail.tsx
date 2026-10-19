import { useEffect, useState, type ReactNode } from 'react';
import type {
  DocumentError,
  JobOutput,
  PublishedDocument,
  ResultDefinition,
  ResultDetail,
} from '@ih/shared';
import { outputExtension } from '@ih/shared';
import type { Api } from '../api/client.js';
import { RdfGraphView, type GraphSemantics } from '../rdf/RdfGraphView.js';
import { display } from '../review/effective.js';
import { Icon } from '../ui/Icon.js';
import { parseCsv } from './csv.js';
import { HelpButton } from '../ui/Help.js';
import { FileBadge } from './FileBadge.js';
import { fullWhen, plural } from './format.js';
import { ResultActions } from './ResultPreview.js';

export const PREVIEW_ROWS = 500;

export const DOCUMENT_ERRORS: Record<DocumentError, string> = {
  'missing from target': 'The published document is missing from the target',
  'target storage unavailable': 'The target storage could not be reached',
  'invalid document': 'The published document in the target is not valid',
};

type Col = { id: string; name?: string; type?: string };
type TableCols = { id: string; name?: string; columns: Col[] };
type Row = Record<string, unknown>;
type Edit = NonNullable<PublishedDocument['review']>['edits'][number];

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
function columnsOf(rows: Row[]): string[] {
  return [...new Set(rows.flatMap((r) => Object.keys(r)))];
}

/** A check's row statuses (worker `checks.run_check`): what each found value matched. */
const CHECK_STATUS: Record<string, { text: string; tone: string; look: boolean }> = {
  match: { text: 'Exact match', tone: 'ok', look: false },
  alias: { text: 'Alias', tone: 'ok', look: false },
  near: { text: 'Near match', tone: 'warn', look: true },
  unmatched: { text: 'Not found', tone: 'danger', look: true },
  unused: { text: 'Not used', tone: 'neutral', look: true },
};
const CHECK_KEYS = ['value', 'status', 'matched', 'distance', 'count'];
/** Rows shaped like a matching check's: shown with readable headings and results. */
const isMatchCheck = (rows: Row[]) =>
  rows.length > 0 && rows.every((r) => CHECK_KEYS.every((k) => k in r));
/** Rows of a check worth a person's look: near matches, values not found, references not used. */
const toLook = (rows: Row[]) => rows.filter((r) => CHECK_STATUS[String(r.status)]?.look).length;

/** Numbers, and the values of number columns, are right-aligned so their digits line up. */
const NUMBER_TYPES = new Set(['integer', 'decimal', 'number']);
const isNumber = (c: Col, v: unknown) =>
  typeof v === 'number' || (c.type !== undefined && NUMBER_TYPES.has(c.type) && v !== null);

const ISSUE_COLUMNS = ['step', 'target', 'row', 'column', 'raw', 'message'];

/** A table's edited cells as `row:column` (1-based rows). The edits are a log: a cell edited
 * twice is one edited cell. */
const editedCells = (edits: Edit[], table: string) =>
  new Set(edits.filter((e) => e.table === table && e.column).map((e) => `${e.row}:${e.column}`));

interface Item {
  key: string;
  group: 'Document' | 'Tables' | 'Checks' | 'More';
  label: string;
  /** The count at the right of the outline row. */
  count: string;
  /** The count is something to look at (edits, near matches, issues). */
  warn?: boolean;
}

export function ResultDetailView({ api, jobId }: { api: Api; jobId: string }) {
  const [result, setResult] = useState<ResultDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    api.getResult(jobId).then(setResult, (err: Error) => setError(err.message));
  }, [api, jobId]);
  const specId = result?.job.specId;
  useEffect(() => {
    if (!specId) return;
    // The document type's name (retired types keep theirs); its id until it is known.
    api.listSpecs({ retired: 'include' }).then(
      (specs) => setTitle(specs.find((s) => s.id === specId)?.title ?? null),
      () => setTitle(null),
    );
  }, [api, specId]);

  const back = (
    <a className="crumb" href="#/results">
      <Icon name="back" />
      Results
    </a>
  );
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
  const files = (
    <FileList
      api={api}
      jobId={job.id}
      outputs={outputs}
      target={`${target.bucket}/${target.prefix}`}
    />
  );

  return (
    <section className="result-detail">
      {back}
      <header className="result-head">
        <FileBadge contentType={job.contentType} large />
        <div className="result-head-text">
          <h1>{job.filename}</h1>
          <dl className="result-meta">
            <div>
              <dt className="visually-hidden">Document type</dt>
              <dd>
                <span className="kind-tag tone-info">
                  {title ?? job.specId} v{job.specVersion}
                </span>
              </dd>
            </div>
            <div>
              <dt>Published</dt>
              <dd>{fullWhen(result.publishedAt)}</dd>
            </div>
            <div>
              <dt>Review</dt>
              <dd>{review}</dd>
            </div>
            <div>
              <dt>Publishing target</dt>
              <dd>
                {target.label}{' '}
                <code>
                  {target.bucket}/{target.prefix}
                </code>
              </dd>
            </div>
          </dl>
        </div>
        <div className="result-head-actions">
          <ResultActions
            api={api}
            jobId={job.id}
            filename={job.filename}
            contentType={job.contentType}
            outputCount={outputs.length}
          />
          <HelpButton topic="result" />
        </div>
      </header>
      {documentError && (
        <p role="alert">{`${DOCUMENT_ERRORS[documentError]} (bucket ${target.bucket}).`}</p>
      )}
      {document ? (
        <DocumentView
          api={api}
          jobId={job.id}
          document={document}
          definition={definition}
          outputs={outputs}
          files={files}
        />
      ) : (
        <>
          <section className="card result-files-card">{files}</section>
          {!documentError && <OutputPreviews api={api} jobId={job.id} outputs={outputs} />}
        </>
      )}
    </section>
  );
}

function FileList({
  api,
  jobId,
  outputs,
  target,
}: {
  api: Api;
  jobId: string;
  outputs: JobOutput[];
  target: string;
}) {
  return (
    <>
      <div className="result-view-head">
        <h3>Published files</h3>
        <span className="muted">
          {plural(outputs.length, 'file')} in <code>{target}</code>
        </span>
      </div>
      <ul className="result-files" aria-label="Published files">
        {outputs.map((o) => (
          <li key={o.outputId}>
            <span className="kind-tag tone-neutral">{o.format.toUpperCase()}</span>
            <a className="mono" href={api.outputUrl(jobId, o.outputId, { stage: 'published' })}>
              {`${o.outputId}.${outputExtension(o.format)}`}
            </a>
            {o.rowCount !== null && <span className="muted">{plural(o.rowCount, 'row')}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

function DocumentView({
  api,
  jobId,
  document,
  definition,
  outputs,
  files,
}: {
  api: Api;
  jobId: string;
  document: PublishedDocument;
  definition: ResultDefinition;
  outputs: JobOutput[];
  files: ReactNode;
}) {
  const edits: Edit[] = document.review?.edits ?? [];
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
  const fieldEdited = (id: string) => edits.some((e) => e.field === id);
  const cellEdits = (t: string) => editedCells(edits, t).size;
  const rowsOf = (t: string) => document.tables[t] ?? [];

  const editedFields = fields.filter((f) => fieldEdited(f.id)).length;
  const totalRows = tables.reduce((n, t) => n + rowsOf(t.id).length, 0);
  const cellsEdited = tables.reduce((n, t) => n + cellEdits(t.id), 0);
  const checksToLook = checks.filter(([, c]) => toLook(c.rows) > 0).length;
  const issues = document.issues;
  const graph = outputs.find((o) => o.format === 'rdf');

  const items: Item[] = [
    ...(fields.length
      ? [
          {
            key: 'fields',
            group: 'Document' as const,
            label: 'Fields',
            count: editedFields ? `${editedFields} edited` : String(fields.length),
            warn: editedFields > 0,
          },
        ]
      : []),
    ...tables.map((t) => {
      const n = cellEdits(t.id);
      return {
        key: `table:${t.id}`,
        group: 'Tables' as const,
        label: label(t),
        count: n ? `${rowsOf(t.id).length} · ${n} edited` : String(rowsOf(t.id).length),
        warn: n > 0,
      };
    }),
    ...checks.map(([id, c]) => {
      const n = toLook(c.rows);
      return {
        key: `check:${id}`,
        group: 'Checks' as const,
        label: id,
        count: n ? `${n} to look at` : 'all matched',
        warn: n > 0,
      };
    }),
    ...(graph
      ? [
          {
            key: 'graph',
            group: 'More' as const,
            label: 'Graph',
            count: graph.rowCount === null ? 'RDF' : plural(graph.rowCount, 'triple'),
          },
        ]
      : []),
    {
      key: 'issues',
      group: 'More',
      label: 'Issues',
      count: String(issues.length),
      warn: issues.length > 0,
    },
    { key: 'files', group: 'More', label: 'Published files', count: String(outputs.length) },
  ];
  const [picked, setPicked] = useState<string>(items[0]!.key);
  const at = Math.max(
    0,
    items.findIndex((i) => i.key === picked),
  );
  const item = items[at]!;
  const tableIndex = tables.findIndex((t) => item.key === `table:${t.id}`);

  const tiles = [
    {
      label: 'Fields',
      n: fields.length,
      note: editedFields ? (
        <>
          <span className="warn">{editedFields} edited</span> in review
        </>
      ) : (
        'none edited in review'
      ),
    },
    {
      label: 'Tables',
      n: tables.length,
      note: (
        <>
          {plural(totalRows, 'row')}
          {cellsEdited > 0 && (
            <>
              {' · '}
              <span className="warn">{plural(cellsEdited, 'cell')} edited</span>
            </>
          )}
        </>
      ),
    },
    {
      label: 'Checks',
      n: checks.length,
      note: checksToLook ? <span className="warn">{checksToLook} to look at</span> : 'all matched',
    },
    {
      label: 'Issues',
      n: issues.length,
      note: issues.length ? (
        <span className="warn">{issues.length} to look at</span>
      ) : (
        'nothing flagged'
      ),
    },
  ];

  const groups = (['Document', 'Tables', 'Checks', 'More'] as const)
    .map((g) => [g, items.filter((i) => i.group === g)] as const)
    .filter(([, list]) => list.length > 0);

  const body = () => {
    if (item.key === 'fields') {
      return (
        <>
          <div className="result-view-head">
            <h3>Fields</h3>
            {editedFields > 0 && <EditedLegend text="Edited in review" />}
          </div>
          <dl className="result-fields">
            {fields.map((f) => {
              const edited = fieldEdited(f.id);
              return (
                <div key={f.id} className={edited ? 'edited-cell' : undefined}>
                  <dt>{label(f)}</dt>
                  <dd>
                    {format(document.fields[f.id]?.value)}
                    {edited && <small className="edited">edited</small>}
                  </dd>
                </div>
              );
            })}
          </dl>
        </>
      );
    }
    if (tableIndex >= 0) {
      const t = tables[tableIndex]!;
      const csv = outputs.find((o) => o.outputId === t.id && o.format === 'csv');
      return (
        <TableView
          key={t.id}
          table={t}
          rows={rowsOf(t.id)}
          edits={edits}
          csvUrl={csv ? api.outputUrl(jobId, csv.outputId, { stage: 'published' }) : null}
          prev={tables[tableIndex - 1]}
          next={
            tables[tableIndex + 1] ?? (checks[0] ? { id: checks[0][0], check: true } : undefined)
          }
          onOpen={(key) => setPicked(key)}
        />
      );
    }
    if (item.key.startsWith('check:')) {
      const id = item.key.slice(6);
      const rows = document.checks[id]?.rows ?? [];
      return <CheckView id={id} rows={rows} />;
    }
    if (item.key === 'graph' && graph) {
      return (
        <ResultGraph
          api={api}
          jobId={jobId}
          output={graph}
          semantics={definition.kind === 'template' ? definition.semantics : undefined}
        />
      );
    }
    if (item.key === 'issues') {
      return (
        <>
          <div className="result-view-head">
            <h3>Issues</h3>
            <span className="muted">{plural(issues.length, 'issue')}</span>
          </div>
          {issues.length === 0 ? (
            <p className="muted result-view-empty">No issues were flagged for this document.</p>
          ) : (
            <SimpleTable
              label="Issues"
              header={ISSUE_COLUMNS}
              rows={issues.map((i) => ISSUE_COLUMNS.map((k) => format(i[k])))}
            />
          )}
        </>
      );
    }
    return files;
  };

  return (
    <>
      <ul className="result-tiles" aria-label="Summary">
        {tiles.map((t) => (
          <li key={t.label} className="card">
            <span className="eyebrow">{t.label}</span>
            <span className="tile-n">{t.n}</span>
            <span className="tile-note">{t.note}</span>
          </li>
        ))}
      </ul>
      <div className="card result-split">
        <nav className="result-outline" aria-label="Result contents">
          {groups.map(([g, list]) => (
            <div key={g}>
              <p className="result-outline-head">
                <span>{g}</span>
                {g === 'Tables' && <span>{plural(totalRows, 'row')}</span>}
                {g === 'Checks' && (
                  <span>
                    {checks.length - checksToLook} of {checks.length} clean
                  </span>
                )}
              </p>
              <ul>
                {list.map((i) => (
                  <li key={i.key}>
                    <button
                      type="button"
                      aria-label={i.label}
                      aria-current={i.key === item.key ? 'true' : undefined}
                      onClick={() => setPicked(i.key)}
                    >
                      <span className="result-outline-label">{i.label}</span>
                      <span
                        className={i.warn ? 'result-outline-count warn' : 'result-outline-count'}
                      >
                        {i.count}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <section className="result-view" aria-label={item.label}>
          {body()}
        </section>
      </div>
    </>
  );
}

function EditedLegend({ text }: { text: string }) {
  return (
    <span className="edited-legend">
      <i aria-hidden="true" />
      {text}
    </span>
  );
}

function TableView({
  table,
  rows,
  edits,
  csvUrl,
  prev,
  next,
  onOpen,
}: {
  table: TableCols;
  rows: Row[];
  edits: Edit[];
  csvUrl: string | null;
  prev?: TableCols;
  next?: { id: string; name?: string; check?: boolean };
  onOpen: (key: string) => void;
}) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const numbered = rows.map((row, i) => ({ row, n: i + 1 }));
  const shown = needle
    ? numbered.filter(({ row }) =>
        table.columns.some((c) => format(row[c.id]).toLowerCase().includes(needle)),
      )
    : numbered;
  const cells = editedCells(edits, table.id);
  const edited = cells.size;
  const name = label(table);
  const nextKey = next && (next.check ? `check:${next.id}` : `table:${next.id}`);
  return (
    <>
      <div className="result-view-head">
        <h3>{name}</h3>
        <span className="muted">
          {plural(rows.length, 'row')} · {plural(table.columns.length, 'column')}
        </span>
        {edited > 0 && <EditedLegend text={`${plural(edited, 'cell')} edited in review`} />}
        <span className="result-view-tools">
          <span className="filter-search">
            <Icon name="search" />
            <input
              type="search"
              className="filter-field"
              aria-label="Filter rows"
              placeholder="Filter rows"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </span>
          {csvUrl && (
            <a className="button" href={csvUrl} aria-label={`Download ${name} as CSV`}>
              <Icon name="download" />
              CSV
            </a>
          )}
        </span>
      </div>
      <div className="result-table-scroll">
        <table className="result-data" aria-label={name}>
          <thead>
            <tr>
              <th className="row-n">#</th>
              {table.columns.map((c) => (
                <th key={c.id} className={c.type && NUMBER_TYPES.has(c.type) ? 'num' : undefined}>
                  {label(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map(({ row, n }) => (
              <tr key={n}>
                <td className="row-n">{n}</td>
                {table.columns.map((c) => {
                  const isEdited = cells.has(`${n}:${c.id}`);
                  const v = row[c.id];
                  return (
                    <td
                      key={c.id}
                      className={
                        [
                          isEdited ? 'edited-cell' : '',
                          isNumber(c, v) ? 'num' : '',
                          display(v) === '—' ? 'nil' : '',
                        ]
                          .filter(Boolean)
                          .join(' ') || undefined
                      }
                      title={isEdited ? 'edited in review' : undefined}
                    >
                      {format(v)}
                      {isEdited && <small className="edited">edited</small>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="result-view-foot muted">
        <span>
          {needle ? `${shown.length} of ${plural(rows.length, 'row')}` : plural(rows.length, 'row')}
        </span>
        <span className="result-step">
          <button
            type="button"
            className="small ghost"
            disabled={!prev}
            aria-label={prev ? `Previous: ${label(prev)}` : 'Previous'}
            onClick={() => prev && onOpen(`table:${prev.id}`)}
          >
            ‹ {prev ? label(prev) : ''}
          </button>
          <button
            type="button"
            className="small ghost"
            disabled={!next}
            aria-label={next ? `Next: ${label(next)}` : 'Next'}
            onClick={() => nextKey && onOpen(nextKey)}
          >
            {next ? label(next) : ''} ›
          </button>
        </span>
      </div>
    </>
  );
}

function CheckView({ id, rows }: { id: string; rows: Row[] }) {
  if (!isMatchCheck(rows)) {
    const header = columnsOf(rows);
    return (
      <>
        <div className="result-view-head">
          <h3>{id}</h3>
          <span className="muted">{plural(rows.length, 'row')}</span>
        </div>
        <SimpleTable
          label={id}
          header={header}
          rows={rows.map((r) => header.map((k) => format(r[k])))}
        />
      </>
    );
  }
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  return (
    <>
      <div className="result-view-head">
        <h3>{id}</h3>
        <span className="muted">Each value found, and the reference it matched</span>
      </div>
      <div className="result-table-scroll">
        <table className="result-data" aria-label={id}>
          <thead>
            <tr>
              <th>Value found</th>
              <th>Result</th>
              <th>Matched to</th>
              <th className="num">Edit distance</th>
              <th className="num">Times seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const st = CHECK_STATUS[String(r.status)];
              return (
                <tr key={i}>
                  <td className="mono">{format(r.value)}</td>
                  <td>
                    <span className={`check-status tone-${st?.tone ?? 'neutral'}`}>
                      <i aria-hidden="true" />
                      {st?.text ?? format(r.status)}
                    </span>
                  </td>
                  <td className={r.matched == null ? 'mono nil' : 'mono'}>{format(r.matched)}</td>
                  <td className={r.distance == null ? 'num nil' : 'num'}>{format(r.distance)}</td>
                  <td className="num">{format(r.count)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="result-view-foot muted">
        <span>
          {count('match')} exact · {count('alias') > 0 && `${count('alias')} alias · `}
          {count('near')} near · {count('unmatched')} not found · {count('unused')} not used
        </span>
      </div>
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

/** A published graph (ADR 0011), read from its target only when its outline item is opened. */
function ResultGraph({
  api,
  jobId,
  output,
  semantics,
}: {
  api: Api;
  jobId: string;
  output: JobOutput;
  semantics: GraphSemantics | undefined;
}) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.getOutputText(jobId, output.outputId, 'published').then(
      (t) => live && setText(t),
      (err: Error) => live && setFailed(err.message),
    );
    return () => {
      live = false;
    };
  }, [api, jobId, output.outputId]);
  return (
    <>
      <div className="result-view-head">
        <h3>Graph</h3>
        <a href={api.outputUrl(jobId, output.outputId, { stage: 'published' })}>Download Turtle</a>
      </div>
      <div className="result-graph">
        {failed && <p role="alert">{failed}</p>}
        {!failed && text === null && <p role="status">Loading the graph…</p>}
        {text !== null && <RdfGraphView api={api} turtle={text} semantics={semantics} />}
      </div>
    </>
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
  if (output.format === 'rdf') return <RdfGraphView api={api} turtle={text} title={name} />;
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
