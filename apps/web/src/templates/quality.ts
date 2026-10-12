import type { TemplateSummary } from '../api/client.js';

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "5 sections · 9 fields · 1 table". */
export function shapeLine(s: TemplateSummary): string {
  return [plural(s.sections, 'section'), plural(s.fields, 'field'), plural(s.tables, 'table')].join(
    ' · ',
  );
}

/**
 * The card's quality line (UI handoff §4), most urgent first: the draft's validation issues, the
 * last regression, then the state of the reference documents.
 */
export function qualityLine(
  s: TemplateSummary,
  draft: number | null,
): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  if (s.draftIssues && draft !== null) {
    return {
      text: `Draft v${draft} has ${plural(s.draftIssues, 'validation issue')}`,
      tone: 'warn',
    };
  }
  if (s.regressionRunning) return { text: 'Regression running…', tone: 'muted' };
  if (s.lastRegression) {
    const { matched, total } = s.lastRegression;
    return {
      text: `Regression: ${matched} of ${total} references match`,
      tone: matched === total ? 'ok' : 'warn',
    };
  }
  if (s.references === 0) return { text: 'No reference documents yet', tone: 'muted' };
  return { text: `${plural(s.references, 'reference')} · no regression run yet`, tone: 'muted' };
}
