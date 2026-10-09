import { useCallback, useEffect, useState } from 'react';
import type { Reference } from '@ih/shared';
import type { Api, RegressionReport, VersionDiff } from '../api/client.js';

const pct = (score: number) => `${Math.round(score * 100)}%`;
const show = (value: unknown) =>
  value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);

/** Version diff + reference regression for one template version. */
export function QualityPanel({
  api,
  templateId,
  version,
}: {
  api: Api;
  templateId: string;
  version: number;
}) {
  const [versions, setVersions] = useState<number[]>([]);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [references, setReferences] = useState<Reference[]>([]);
  const [report, setReport] = useState<RegressionReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [refs, regression] = await Promise.all([
        api.listReferences(templateId),
        api.getRegression(templateId, version),
      ]);
      setReferences(refs);
      setReport(regression);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, templateId, version]);

  useEffect(() => {
    void refresh();
    api.listTemplates().then(
      (items) =>
        setVersions(
          (items.find((t) => t.id === templateId)?.versions ?? [])
            .map((v) => v.version)
            .filter((v) => v !== version),
        ),
      () => setVersions([]),
    );
  }, [api, templateId, version, refresh]);

  const compare = async (from: string) => {
    setDiff(null);
    if (!from) return;
    try {
      setDiff(await api.diffVersions(templateId, Number(from), version));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const run = async () => {
    try {
      await api.runRegression(templateId, version);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="quality">
      {error && <p role="alert">{error}</p>}

      <h3>Changes</h3>
      <label>
        Compare with
        <select defaultValue="" onChange={(e) => void compare(e.target.value)}>
          <option value="">— choose a version —</option>
          {versions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {diff &&
        (diff.changes.length === 0 ? (
          <p>
            No differences between v{diff.from} and v{diff.to}.
          </p>
        ) : (
          <table aria-label="changes">
            <thead>
              <tr>
                <th>Change</th>
                <th>Where</th>
                <th>v{diff.from}</th>
                <th>v{diff.to}</th>
              </tr>
            </thead>
            <tbody>
              {diff.changes.map((c) => (
                <tr key={`${c.kind}:${c.path}`}>
                  <td>{c.kind}</td>
                  <td>
                    <code>{c.path}</code>
                  </td>
                  <td className="diff-before">{show(c.before)}</td>
                  <td className="diff-after">{show(c.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      <h3>Regression against references</h3>
      {references.length === 0 ? (
        <p>
          No references yet. Open a finished document of this type in review and use “Save as
          reference”.
        </p>
      ) : (
        <>
          <p>
            {references.length} reference(s):{' '}
            {references.map((r) => (
              <span key={r.id} className="reference">
                {r.name}{' '}
                <button
                  type="button"
                  className="link"
                  aria-label={`Delete reference ${r.name}`}
                  onClick={() =>
                    void api
                      .deleteReference(templateId, r.id)
                      .then(refresh, (err: Error) => setError(err.message))
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </p>
          <button type="button" onClick={() => void run()}>
            Run regression on v{version}
          </button>{' '}
          <button type="button" className="link" onClick={() => void refresh()}>
            Refresh
          </button>
        </>
      )}
      {report && report.items.length > 0 && (
        <>
          <p>
            {report.summary.completed} of {report.summary.references} finished
            {report.summary.averageScore !== null &&
              ` · Average score ${pct(report.summary.averageScore)}`}
          </p>
          <table aria-label="regression">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Run</th>
                <th>Score</th>
                <th>Differences</th>
              </tr>
            </thead>
            <tbody>
              {report.items.map((item) => {
                const c = item.comparison;
                const fields = c?.fields.filter((f) => !f.match) ?? [];
                const tables = c?.tables.filter((t) => t.missing.length || t.extra.length) ?? [];
                return (
                  <tr key={item.reference.id}>
                    <td>{item.reference.name}</td>
                    <td>
                      {item.job ? (
                        <a href={`#/review/${item.job.id}`}>{item.job.status}</a>
                      ) : (
                        'not run'
                      )}
                    </td>
                    <td>{c ? pct(c.score) : '—'}</td>
                    <td>
                      {fields.map((f) => (
                        <div
                          key={f.id}
                          title={`expected ${show(f.expected)}, got ${show(f.actual)}`}
                        >
                          {f.id}: {show(f.expected)} → {show(f.actual)}
                        </div>
                      ))}
                      {tables.map((t) => (
                        <div key={t.id}>
                          {t.id}: {t.missing.length} missing, {t.extra.length} extra
                        </div>
                      ))}
                      {c && !fields.length && !tables.length && 'none'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
