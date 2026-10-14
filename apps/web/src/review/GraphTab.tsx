import { useEffect, useState } from 'react';
import type { ShaclReport } from '@ih/shared';
import type { Api } from '../api/client.js';

/** A result on a property no output publishes names the property's IRI. */
const IRI = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The document's graph (ADR 0011): the draft Turtle and the SHACL report of the recipe's shapes.
 * Each result opens the output it names (a field, a table or `table.column`).
 */
export function GraphTab({
  api,
  jobId,
  onOpenOutput,
}: {
  api: Api;
  jobId: string;
  onOpenOutput: (output: string) => void;
}) {
  const [turtle, setTurtle] = useState<string | null>(null);
  const [report, setReport] = useState<ShaclReport | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.getOutputText(jobId, 'graph', 'draft').then(
      (text) => live && setTurtle(text),
      (err: unknown) => live && setError((err as Error).message),
    );
    api.getShaclReport(jobId).then(
      (r) => live && setReport(r),
      (err: unknown) => live && setError((err as Error).message),
    );
    return () => {
      live = false;
    };
  }, [api, jobId]);
  return (
    <div className="graph-tab">
      <section aria-labelledby="graph-shacl">
        <h3 id="graph-shacl">Shapes</h3>
        {report === undefined && !error && <p className="muted">Loading…</p>}
        {report === null && <p className="muted">No SHACL report: the recipe pins no shapes.</p>}
        {report && report.results.length === 0 && <p>The graph conforms to the shapes.</p>}
        {report && report.results.length > 0 && (
          <ul aria-label="SHACL results" className="shacl-results">
            {report.results.map((r, i) => (
              <li key={i} className={r.severity === 'Violation' ? 'field-error' : undefined}>
                <strong>{r.severity}</strong> {r.message}
                {r.value && (
                  <>
                    {' '}
                    (<code>{r.value}</code>)
                  </>
                )}{' '}
                {IRI.test(r.output) ? (
                  <code>{r.output}</code>
                ) : (
                  <button type="button" onClick={() => onOpenOutput(r.output)}>
                    Show {r.output}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {error && <p role="alert">{error}</p>}
      <section aria-labelledby="graph-turtle">
        <h3 id="graph-turtle">Graph</h3>
        {turtle !== null && <pre className="turtle">{turtle}</pre>}
      </section>
    </div>
  );
}
