import type { SampleRole } from '@ih/shared';
import { sectionTone, TONE_COLOR } from '../ui/stageStyle.js';

/** Dev = info "DEV", holdout = skip (violet) "HOLDOUT" (handoff §0.6): text, never colour alone. */
export function SampleTag({ role }: { role: SampleRole }) {
  return (
    <span className={`sample-tag tone-${role === 'dev' ? 'info' : 'skip'}`}>
      {role === 'dev' ? 'DEV' : 'HOLDOUT'}
    </span>
  );
}

/** A section id with its colour dot; `index` is its place in the draft's sections (-1: none). */
export function SectionChip({ id, index }: { id: string; index: number }) {
  const color = index < 0 ? TONE_COLOR.neutral : TONE_COLOR[sectionTone(index)];
  return (
    <span className="section-chip">
      <span className="section-dot" aria-hidden="true" style={{ background: color }} />
      <code>{id}</code>
      {index < 0 && <span className="visually-hidden">(not a section of the draft)</span>}
    </span>
  );
}
