import type { SampleView, SegmentationResult } from '@ih/shared';
import { SampleTag } from './tags.js';
import { cellFlag, cellShare, sectionHits, type CellFlag, type Selection } from './segmentation.js';

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
  sections,
  samples,
  onOpen,
  selected = null,
}: {
  result: SegmentationResult;
  sections: { id: string; required: boolean }[];
  samples: SampleView[];
  onOpen: (sampleId: string, sectionId: string) => void;
  selected?: Selection | null;
}) {
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
              {sections.map((s) => {
                const { hits, of } = sectionHits(result, s.id);
                const short = s.required && hits < of;
                return (
                  <th
                    key={s.id}
                    scope="col"
                    aria-label={`${s.id}, matched in ${hits} of ${of} samples`}
                  >
                    <code>{s.id}</code>{' '}
                    <small
                      className={short ? 'tone-text-danger' : 'tone-text-ok'}
                    >{`${hits}/${of}`}</small>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {result.samples.map((row) => {
              const view = byId.get(row.sampleId);
              const name = view?.filename ?? row.sampleId;
              return (
                <tr key={row.sampleId} aria-label={name}>
                  <th scope="row">
                    {name} {view && <SampleTag role={view.role} />}
                  </th>
                  {row.error !== null ? (
                    <td colSpan={Math.max(1, sections.length)} className="muted">
                      {row.error}
                    </td>
                  ) : (
                    sections.map((s) => {
                      const cell = row.sections.find((c) => c.id === s.id);
                      const flag = cell ? cellFlag(cell, s.required, row, sections.length) : null;
                      const state = cell === undefined ? null : (flag ?? 'found');
                      const descId = `seg-${row.sampleId}-${s.id}`;
                      return (
                        <td key={s.id} className={state ? `cell-${state}` : undefined}>
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
                              {flag && flag !== 'large' && (
                                <span className="flag"> {FLAG_TEXT[flag]}</span>
                              )}
                            </span>
                          </button>
                        </td>
                      );
                    })
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
