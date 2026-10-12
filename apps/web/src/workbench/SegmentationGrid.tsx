import type { SampleView, SegmentationResult } from '@ih/shared';
import { cellFlag, sectionHits, type CellFlag } from './segmentation.js';

const FLAG_TEXT: Record<Exclude<CellFlag, null>, string> = {
  'missing-required': 'missing (required)',
  missing: 'missing',
  empty: 'empty',
  large: 'very large',
};

/** Samples × sections: where each anchor lands (page · characters), with problems flagged. */
export function SegmentationGrid({
  result,
  sections,
  samples,
  onOpen,
}: {
  result: SegmentationResult;
  sections: { id: string; required: boolean }[];
  samples: SampleView[];
  onOpen: (sampleId: string, sectionId: string) => void;
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
      <table aria-label="Section anchors">
        <thead>
          <tr>
            <th scope="col">Sample</th>
            {sections.map((s) => {
              const { hits, of } = sectionHits(result, s.id);
              return (
                <th
                  key={s.id}
                  scope="col"
                  aria-label={`${s.id}, matched in ${hits} of ${of} samples`}
                >
                  <code>{s.id}</code> <small>{`${hits}/${of}`}</small>
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
                  {name} <small className="muted">{view?.role}</small>
                </th>
                {row.error !== null ? (
                  <td colSpan={Math.max(1, sections.length)} className="muted">
                    {row.error}
                  </td>
                ) : (
                  sections.map((s) => {
                    const cell = row.sections.find((c) => c.id === s.id);
                    const flag = cell ? cellFlag(cell, s.required, row, sections.length) : null;
                    const descId = `seg-${row.sampleId}-${s.id}`;
                    return (
                      <td key={s.id} className={flag ? `cell-${flag}` : undefined}>
                        <button
                          type="button"
                          className="link"
                          aria-label={`${name} · ${s.id}`}
                          aria-describedby={descId}
                          title={cell?.line ?? undefined}
                          onClick={() => onOpen(row.sampleId, s.id)}
                        >
                          <span id={descId}>
                            {cell === undefined && 'not in preview yet'}
                            {cell?.found ? `p.${cell.page} · ${cell.chars}` : ''}
                            {flag && <span className="flag"> {FLAG_TEXT[flag]}</span>}
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
  );
}
