import type { SampleView, SegmentationResult } from '@ih/shared';
import { SampleTag, SectionChip } from './tags.js';
import { Fragment } from 'react';
import {
  cellFlag,
  cellShare,
  missedKeysText,
  occurrenceSummary,
  sectionHits,
  type CellFlag,
  type Selection,
} from './segmentation.js';

const FLAG_TEXT: Record<Exclude<CellFlag, null>, string> = {
  'missing-required': 'Missing (required)',
  missing: 'Missing (optional)',
  empty: 'Empty',
  large: 'Swallows > 60% of the text',
};
const LEGEND = [
  ['found', 'Found'],
  ['large', 'Swallows > 60% of the text'],
  ['missing-required', 'Missing (required)'],
  ['missing', 'Missing (optional)'],
] as const;

/** Samples × sections (handoff §5): where each anchor lands; a cell selects sample + section. */
export function SegmentationGrid({
  result,
  sections: rawSections,
  samples,
  onOpen,
  selected = null,
}: {
  result: SegmentationResult;
  sections: { id: string; required: boolean; keyFrom?: string }[];
  samples: SampleView[];
  onOpen: (sampleId: string, sectionId: string) => void;
  selected?: Selection | null;
}) {
  // Only columns with a usable id: a new row (empty id) or a repeated one has no column yet.
  const sections = rawSections.filter(
    (s, i) => s.id && rawSections.findIndex((o) => o.id === s.id) === i,
  );
  const seen = new Set(result.samples.flatMap((r) => r.sections.map((c) => c.id)));
  const byId = new Map(samples.map((s) => [s.id, s]));
  const errors = Object.entries(result.anchorErrors);
  return (
    <div className="segmentation-grid">
      {errors.length > 0 && (
        <ul role="alert" className="anchor-errors">
          {errors.map(([id, message]) => (
            <li key={id}>
              <code>{id}</code>: {message}
            </li>
          ))}
        </ul>
      )}
      <ul className="seg-legend" aria-label="Cell states">
        {LEGEND.map(([state, text]) => (
          <li key={state}>
            <span className={`seg-swatch cell-${state}`} aria-hidden="true" />
            {text}
          </li>
        ))}
      </ul>
      <div className="table-scroll">
        <table aria-label="Section anchors">
          <thead>
            <tr>
              <th scope="col">Sample</th>
              {sections.map((s, col) => {
                // A section the preview has not run yet (renamed or new) is pending, not 0 hits.
                const pending = !seen.has(s.id);
                const { hits, of } = sectionHits(result, s.id);
                const short = !pending && s.required && hits < of;
                return (
                  <th
                    key={col}
                    scope="col"
                    aria-label={
                      pending
                        ? `${s.id}, not in the preview yet`
                        : `${s.id}, matched in ${hits} of ${of} samples`
                    }
                  >
                    <code>{s.id}</code>{' '}
                    {pending ? (
                      <small className="muted">–</small>
                    ) : (
                      <small
                        className={short ? 'tone-text-danger' : 'tone-text-ok'}
                      >{`${hits}/${of}`}</small>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {result.samples.map((row) => {
              const view = byId.get(row.sampleId);
              const name = view?.filename ?? row.sampleId;
              const keyIssues = row.keyIssues ?? [];
              const missedText = missedKeysText(row);
              const firstMissed = row.missedKeys?.[0];
              return (
                <Fragment key={row.sampleId}>
                  <tr aria-label={name}>
                    <th scope="row">
                      {name} {view && <SampleTag role={view.role} />}
                    </th>
                    {row.error !== null ? (
                      <td colSpan={Math.max(1, sections.length)} className="muted">
                        {row.error}
                      </td>
                    ) : (
                      sections.map((s, col) => {
                        const cell = row.sections.find((c) => c.id === s.id);
                        const flag = cell ? cellFlag(cell, s.required, row, sections.length) : null;
                        const state = cell === undefined ? null : (flag ?? 'found');
                        const descId = `seg-${row.sampleId}-${col}`;
                        return (
                          <td key={col} className={state ? `cell-${state}` : undefined}>
                            <button
                              type="button"
                              className="seg-cell"
                              aria-label={`${name} · ${s.id}`}
                              aria-describedby={descId}
                              aria-pressed={
                                selected?.sampleId === row.sampleId && selected.sectionId === s.id
                              }
                              title={cell?.line ?? undefined}
                              onClick={() => onOpen(row.sampleId, s.id)}
                            >
                              <span id={descId}>
                                {cell === undefined && 'not in preview yet'}
                                {cell?.found && (
                                  <>
                                    {`p.${cell.page} · ${cell.chars}`}
                                    <small>
                                      {flag === 'large'
                                        ? ` ${Math.round(cellShare(cell, row) * 100)}% of text`
                                        : ' chars'}
                                    </small>
                                  </>
                                )}
                                {flag === 'large' && (
                                  <span className="visually-hidden">
                                    , swallows more than 60% of the text
                                  </span>
                                )}
                                {cell?.found && (cell.matches ?? 1) > 1 && (
                                  <span className="flag">
                                    {' '}
                                    · matches {cell.matches}×
                                    <span className="visually-hidden">
                                      : only the first starts the section
                                    </span>
                                  </span>
                                )}
                                {flag && flag !== 'large' && (
                                  <span className="flag"> {FLAG_TEXT[flag]}</span>
                                )}
                                {cell && occurrenceSummary(cell) && (
                                  <span className="seg-occurrences">
                                    {occurrenceSummary(cell)}
                                    {(cell.occurrences ?? [])
                                      .filter((o) => o.keySource === 'inherited' && o.key)
                                      .map((o) => (
                                        <small key={o.key} className="muted">
                                          {` (${o.key} from ${s.keyFrom ?? 'its heading'})`}
                                        </small>
                                      ))}
                                  </span>
                                )}
                              </span>
                            </button>
                          </td>
                        );
                      })
                    )}
                  </tr>
                  {keyIssues.length > 0 && (
                    <tr className="seg-key-issues">
                      <td colSpan={Math.max(1, sections.length) + 1}>
                        <div role="note" aria-label={`Key issues in ${name}`}>
                          <ul>
                            {keyIssues.map((issue) => (
                              <li key={issue} className="tone-text-warn">
                                {issue}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </td>
                    </tr>
                  )}
                  {missedText && firstMissed && (
                    <tr className="seg-key-issues">
                      <td colSpan={Math.max(1, sections.length) + 1}>
                        <div role="note" aria-label={`Missed headings in ${name}`}>
                          <p className="tone-text-warn">
                            {missedText}
                            {' · '}
                            {firstMissed.sections.map((id) => (
                              <SectionChip
                                key={id}
                                id={id}
                                index={rawSections.findIndex((o) => o.id === id)}
                              />
                            ))}
                          </p>
                          <small className="muted">{firstMissed.line}</small>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
