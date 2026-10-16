import { describe, expect, it } from 'vitest';
import type { SampleView } from '@ih/shared';
import {
  batchProgress,
  formatBytes,
  holdoutLine,
  prepareFraction,
  prepareNote,
  sampleMeta,
  samplePages,
  sampleSummary,
  uploadNote,
} from '../src/workbench/samples.js';
import { sampleView } from './fake-api.js';

const triage = (
  pageCount: number,
  ocrPages: number[],
  ocrModel: string | null = 'local/olmocr',
) => ({
  sha256: 'abc',
  pageCount,
  ocrPages,
  chars: 100,
  ocrModel,
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [900, '900 B'],
    [96 * 1024, '96 KB'],
    [184_320, '180 KB'],
    [1024 * 1024 - 1, '1.0 MB'], // never "1024 KB"
    [1.2 * 1024 * 1024, '1.2 MB'],
    [3_250_000, '3.1 MB'],
  ])('%i bytes read %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe('sampleSummary', () => {
  it('counts ready samples per role, capacity and OCR pages', () => {
    const samples: SampleView[] = [
      sampleView({ role: 'dev', triage: triage(2, []) }),
      sampleView({ role: 'dev', triage: triage(3, [1, 2, 3]) }),
      sampleView({ role: 'dev', state: 'preparing', triage: null }),
      sampleView({ role: 'holdout', triage: triage(1, []) }),
      sampleView({ role: 'holdout', state: 'failed', triage: null }),
    ];
    expect(sampleSummary(samples)).toEqual({
      dev: { ready: 2, total: 3 },
      holdout: { ready: 1, total: 2 },
      used: 5,
      slots: 7,
      ocrPages: 3,
      pages: 6,
    });
  });

  it('never has negative slots', () => {
    const many = Array.from({ length: 13 }, () => sampleView());
    expect(sampleSummary(many).slots).toBe(0);
  });
});

describe('sampleMeta', () => {
  it.each<[string, Partial<SampleView>, string]>([
    [
      'ready with OCR',
      { triage: triage(3, [1, 2, 3]), sizeBytes: 1.2 * 1024 * 1024 },
      '3 pages · 3 OCR · 1.2 MB · added for v1',
    ],
    [
      'one page, no OCR',
      { triage: triage(1, []), sizeBytes: 96 * 1024, addedForVersion: 2 },
      '1 page · 96 KB · added for v2',
    ],
    [
      'not prepared',
      { triage: null, state: 'failed', sizeBytes: 88 * 1024, addedForVersion: 4 },
      'Pages unknown · 88 KB · added for v4',
    ],
  ])('%s', (_name, o, text) => {
    expect(sampleMeta(sampleView(o))).toBe(text);
  });
});

describe('samplePages', () => {
  it.each<[string, Partial<SampleView>, number | null]>([
    ['prepared', { triage: triage(4, []) }, 4],
    [
      'reading OCR pages, the worker named the total',
      { state: 'preparing', triage: null, prepare: { stage: 'ocr', page: 1, of: 2, pages: 7 } },
      7,
    ],
    [
      'text layer read (an older worker)',
      { state: 'preparing', triage: null, prepare: { stage: 'text', page: 5, of: 5 } },
      5,
    ],
    [
      'OCR under way (an older worker): only the OCR pages are known',
      { state: 'preparing', triage: null, prepare: { stage: 'ocr', page: 1, of: 2 } },
      null,
    ],
    ['nothing read yet', { state: 'preparing', triage: null, prepare: null }, null],
  ])('%s', (_name, o, pages) => {
    expect(samplePages(sampleView(o))).toBe(pages);
  });
});

describe('prepareFraction', () => {
  const preparing = (o: Partial<SampleView>) =>
    sampleView({ state: 'preparing', triage: null, prepareStatus: 'running', ...o });
  it.each<[string, SampleView, number | null]>([
    ['ready', sampleView(), 1],
    ['failed: no bar', sampleView({ state: 'failed', triage: null }), null],
    ['waiting for a worker', preparing({ prepareStatus: 'queued' }), 0],
    ['reading the document', preparing({ prepare: null }), 0.05],
    ['text layer read', preparing({ prepare: { stage: 'text', page: 4, of: 4 } }), 0.1],
    ['OCR 1 of 4 pages', preparing({ prepare: { stage: 'ocr', page: 1, of: 4 } }), 0.325],
    ['OCR all pages', preparing({ prepare: { stage: 'ocr', page: 4, of: 4 } }), 1],
    ['OCR of nothing', preparing({ prepare: { stage: 'ocr', page: 0, of: 0 } }), 0.1],
  ])('%s', (_name, s, fraction) => {
    expect(prepareFraction(s)).toBe(fraction);
  });
});

describe('uploadNote', () => {
  it.each([
    [{ sent: 0, total: 100, started: false }, 'Waiting to upload'],
    [{ sent: 45, total: 100, started: true }, 'Uploading — 45%'],
    [{ sent: 0, total: 0, started: true }, 'Uploading — 0%'],
  ])('%j reads %s', (u, text) => {
    expect(uploadNote(u)).toBe(text);
  });
});

describe('batchProgress', () => {
  it('is null with nothing uploading or preparing', () => {
    expect(batchProgress([sampleView(), sampleView({ state: 'failed' })], 0)).toBeNull();
  });

  it('counts ready, uploading, preparing and failed, and averages how far each is', () => {
    const samples = [
      sampleView(),
      sampleView({ state: 'failed', triage: null }),
      sampleView({ state: 'preparing', prepareStatus: 'queued', triage: null }),
      sampleView({
        state: 'preparing',
        prepareStatus: 'running',
        triage: null,
        prepare: { stage: 'ocr', page: 2, of: 4 },
      }),
    ];
    // ready 1 + failed 1 (done) + 0 + 0.55, plus two uploads at 0, over 6.
    expect(batchProgress(samples, 2)).toEqual({
      text: '1 of 6 ready · 2 uploading · 2 preparing · 1 failed',
      value: 2.55 / 6,
    });
    expect(batchProgress(samples.slice(2), 0)!.text).toBe('0 of 2 ready · 2 preparing');
  });
});

describe('prepareNote', () => {
  it.each<[string, Partial<SampleView>, ReturnType<typeof prepareNote>]>([
    [
      'waiting for a worker',
      { state: 'preparing', prepareStatus: 'queued', triage: null, prepare: null },
      { text: 'Waiting for a worker…', tone: 'info' },
    ],
    [
      'just claimed: reading (or converting) the document',
      { state: 'preparing', prepareStatus: 'running', triage: null, prepare: null },
      { text: 'Preparing — reading the document…', tone: 'info' },
    ],
    [
      'preparing, status unknown (an older API)',
      { state: 'preparing', triage: null, prepare: null },
      { text: 'Preparing…', tone: 'info' },
    ],
    [
      'text layer read',
      { state: 'preparing', triage: null, prepare: { stage: 'text', page: 3, of: 3 } },
      { text: 'Preparing — text layer read (3 pages)', tone: 'info' },
    ],
    [
      'OCR under way: the page in progress',
      { state: 'preparing', triage: null, prepare: { stage: 'ocr', page: 1, of: 3 } },
      { text: 'Preparing — OCR page 2 of 3', tone: 'info' },
    ],
    [
      'OCR done, writing the text',
      { state: 'preparing', triage: null, prepare: { stage: 'ocr', page: 3, of: 3 } },
      { text: 'Preparing — OCR page 3 of 3', tone: 'info' },
    ],
    [
      'password-protected',
      {
        state: 'failed',
        triage: null,
        prepareError: { code: 'password', message: 'PDF is password-protected' },
      },
      {
        text: 'PDF is password-protected. Remove the password and upload it again.',
        tone: 'danger',
      },
    ],
    [
      'too large to convert',
      { state: 'failed', triage: null, prepareError: { code: 'too_large', message: '413: …' } },
      {
        text: 'The file is too large to convert. Split it or make it smaller, then upload it again.',
        tone: 'danger',
      },
    ],
    [
      'damaged',
      {
        state: 'failed',
        triage: null,
        prepareError: { code: 'corrupt', message: 'PDF could not be read: EOF' },
      },
      {
        text: 'The file is damaged or not a readable PDF or Word document. Save or export it again and upload the new copy.',
        tone: 'danger',
      },
    ],
    [
      'any other reason, in its own words',
      {
        state: 'failed',
        triage: null,
        error: 'OCR down',
        prepareError: { code: 'other', message: 'OCR down' },
      },
      { text: 'Could not prepare it: OCR down', tone: 'danger' },
    ],
    ['ready, text layer only', { triage: triage(2, []) }, null],
    [
      'scanned',
      { triage: triage(3, [1, 2, 3]) },
      { text: 'Scanned — all 3 pages read by OCR', tone: 'muted' },
    ],
    [
      'one scanned page',
      { triage: triage(1, [1]) },
      { text: 'Scanned — its page read by OCR', tone: 'muted' },
    ],
    [
      'some pages',
      { triage: triage(4, [2, 3]) },
      { text: 'Pages 2, 3 read by OCR', tone: 'muted' },
    ],
    [
      'one page, no model recorded',
      { triage: triage(4, [2], null) },
      { text: 'Page 2 read by OCR', tone: 'muted' },
    ],
  ])('%s', (_name, o, note) => {
    expect(prepareNote(sampleView(o))).toEqual(note);
  });

  it('never shows the OCR model ref', () => {
    const text = prepareNote(sampleView({ triage: triage(3, [1, 2, 3], 'local/olmocr') }))!.text;
    expect(text).not.toContain('local/olmocr');
    expect(text).not.toContain('olmocr');
  });
});

describe('holdoutLine', () => {
  it.each([
    [0, 'Not used in a holdout evaluation yet · never sent to a model'],
    [1, 'Used in 1 holdout evaluation · never sent to a model'],
    [3, 'Used in 3 holdout evaluations · never sent to a model'],
  ])('%i runs', (runs, text) => {
    expect(holdoutLine(runs)).toBe(text);
  });
});
