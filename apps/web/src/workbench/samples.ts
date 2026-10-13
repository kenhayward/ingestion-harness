import { MAX_SAMPLES, type PrepareError, type SampleView } from '@ih/shared';

/** Copy guidance (handoff §1), not enforced: 3–8 dev samples; the gate wants ≥ 2 holdout. */
export const DEV_TARGET = { min: 3, max: 8 } as const;
export const HOLDOUT_MIN = 2;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface SampleSummary {
  dev: { ready: number; total: number };
  holdout: { ready: number; total: number };
  used: number;
  slots: number;
  ocrPages: number;
  pages: number;
}

/** The four summary cards: ready per role, capacity, OCR'd pages of the prepared pages. */
export function sampleSummary(samples: readonly SampleView[]): SampleSummary {
  const count = (role: SampleView['role']) => ({
    ready: samples.filter((s) => s.role === role && s.state === 'ready').length,
    total: samples.filter((s) => s.role === role).length,
  });
  const triaged = samples.flatMap((s) => (s.triage ? [s.triage] : []));
  return {
    dev: count('dev'),
    holdout: count('holdout'),
    used: samples.length,
    slots: Math.max(0, MAX_SAMPLES - samples.length),
    ocrPages: triaged.reduce((n, t) => n + t.ocrPages.length, 0),
    pages: triaged.reduce((n, t) => n + t.pageCount, 0),
  };
}

/** "3 pages · 3 OCR · 1.2 MB · added for v1". */
export function sampleMeta(s: SampleView): string {
  const parts = [s.triage ? plural(s.triage.pageCount, 'page') : 'Pages unknown'];
  if (s.triage && s.triage.ocrPages.length > 0) parts.push(`${s.triage.ocrPages.length} OCR`);
  parts.push(formatBytes(s.sizeBytes), `added for v${s.addedForVersion}`);
  return parts.join(' · ');
}

/** Plain words for a failed preparation (handoff §1); `other` shows the worker's message. */
export const PREPARE_ERROR_TEXT: Record<Exclude<PrepareError['code'], 'other'>, string> = {
  password: 'PDF is password-protected. Remove the password and upload it again.',
  corrupt:
    'The file is damaged or not a readable PDF or Word document. Save or export it again and upload the new copy.',
  too_large: 'The file is too large to convert. Split it or make it smaller, then upload it again.',
};

export type NoteTone = 'muted' | 'info' | 'danger';

/** The row's one-line note: live progress, the failure reason, or how OCR read it. */
export function prepareNote(s: SampleView): { text: string; tone: NoteTone } | null {
  if (s.state === 'preparing') {
    const p = s.prepare;
    if (!p) return { text: 'Preparing…', tone: 'info' };
    if (p.stage === 'text') {
      return { text: `Preparing — text layer read (${plural(p.of, 'page')})`, tone: 'info' };
    }
    return { text: `Preparing — OCR page ${Math.min(p.page + 1, p.of)} of ${p.of}`, tone: 'info' };
  }
  if (s.state === 'failed') {
    const err: PrepareError = s.prepareError ?? {
      code: 'other',
      message: s.error ?? 'preparation failed',
    };
    return {
      text:
        err.code === 'other'
          ? `Could not prepare it: ${err.message}`
          : PREPARE_ERROR_TEXT[err.code],
      tone: 'danger',
    };
  }
  const t = s.triage;
  if (!t || t.ocrPages.length === 0) return null;
  const by = t.ocrModel ? ` (${t.ocrModel})` : '';
  if (t.ocrPages.length === t.pageCount) {
    const which = t.pageCount === 1 ? 'its page' : `all ${t.pageCount} pages`;
    return { text: `Scanned — ${which} read by OCR${by}`, tone: 'muted' };
  }
  const label = t.ocrPages.length === 1 ? 'Page' : 'Pages';
  return { text: `${label} ${t.ocrPages.join(', ')} read by OCR${by}`, tone: 'muted' };
}

/** Holdout rows (handoff §1): how often the gate used it; never sent to a model (§0.3). */
export function holdoutLine(runs: number): string {
  const used =
    runs === 0
      ? 'Not used in a holdout evaluation yet'
      : `Used in ${plural(runs, 'holdout evaluation')}`;
  return `${used} · never sent to a model`;
}
