import { useId, useState } from 'react';
import { Segmented } from '../ui/Segmented.js';
import { changedRows, outputRows, outputSummary, type VsLive } from './outputRows.js';

const VS_LABEL: Record<Exclude<VsLive, null>, string> = {
  added: '+ ADDED',
  changed: '~ CHANGED',
  removed: '− REMOVED',
};
const VS_TONE: Record<Exclude<VsLive, null>, string> = {
  added: 'ok',
  changed: 'info',
  removed: 'danger',
};

/** Handoff §4: summary chips and the draft's outputs compared with the live version. */
export function OutputsView({
  draftVersion,
  liveVersion,
  draftDef,
  liveDef,
}: {
  draftVersion: number;
  liveVersion: number | null;
  draftDef: Record<string, unknown>;
  liveDef: Record<string, unknown> | null;
}) {
  const headingId = useId();
  const [filter, setFilter] = useState<'all' | 'changed'>('all');
  const compared = liveVersion !== null && liveDef !== null;
  const rows = outputRows(draftDef, compared ? liveDef : null);
  const s = outputSummary(rows);
  const shown = compared && filter === 'changed' ? changedRows(rows) : rows;
  return (
    <>
      <ul className="summary-chips" aria-label="Outputs summary">
        <li className="tone-neutral">
          {s.fields} {s.fields === 1 ? 'field' : 'fields'}
        </li>
        <li className="tone-neutral">
          {s.tables} {s.tables === 1 ? 'table' : 'tables'} · {s.columns}{' '}
          {s.columns === 1 ? 'column' : 'columns'}
        </li>
        {compared && (
          <>
            <li className="tone-ok">+{s.added} added</li>
            <li className="tone-info">~{s.changed} changed</li>
            <li className="tone-danger">−{s.removed} removed</li>
          </>
        )}
      </ul>
      <section className="card outputs-card" aria-labelledby={headingId}>
        <header className="outputs-card-head">
          <h3 id={headingId}>Outputs in draft v{draftVersion}</h3>
          {compared && <span className="muted">Compared with live v{liveVersion}</span>}
          {compared && (
            <Segmented
              label="Show outputs"
              options={[
                { value: 'all', label: 'All outputs' },
                { value: 'changed', label: `Changed since v${liveVersion}` },
              ]}
              value={filter}
              onChange={setFilter}
            />
          )}
        </header>
        <div className="outputs-scroll">
          <table className="outputs-table">
            <thead>
              <tr>
                {compared && <th scope="col">vs v{liveVersion}</th>}
                <th scope="col">Id</th>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Values</th>
                <th scope="col">Description</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr
                  key={`${r.table ?? ''}/${r.kind}/${r.id}`}
                  className={r.vsLive === 'removed' ? 'removed' : undefined}
                >
                  {compared && (
                    <td>
                      {r.vsLive && (
                        <span className={`kind-tag tone-${VS_TONE[r.vsLive]}`}>
                          {VS_LABEL[r.vsLive]}
                        </span>
                      )}
                    </td>
                  )}
                  <td className={r.kind === 'column' ? 'output-id output-column' : 'output-id'}>
                    {r.kind === 'table' && <span className="kind-tag tone-ok">TABLE</span>}
                    <code>{r.id}</code>
                  </td>
                  <td className="output-name">{r.name}</td>
                  <td>
                    <code className="type-chip">{r.type}</code>
                  </td>
                  <td>{r.values}</td>
                  <td>{r.description}</td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={compared ? 6 : 5} className="muted">
                    {compared ? `Nothing changed since v${liveVersion}.` : 'No outputs yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
