import { describe, expect, it } from 'vitest';
import {
  diagnosticsCount,
  runDiagnostics,
  type DiagnosticRun,
  MAX_EXAMPLES,
} from '../src/index.js';

const run = (over: Partial<DiagnosticRun> = {}): DiagnosticRun => ({
  jobId: 'j1',
  sample: 'a.pdf',
  events: [],
  stepRuns: [],
  issues: [],
  ...over,
});
const stepRun = (stepId: string, start: string, end: string, cached = false) => ({
  stepId,
  startedAt: start,
  finishedAt: end,
  cached,
});

describe('runDiagnostics', () => {
  it('flags a repeating step whose calls are mostly empty', () => {
    const d = runDiagnostics(
      [
        run({
          events: [
            {
              message: 'extracted lines',
              data: { model: 'm', attempts: 1, calls: 30, emptyCalls: 25 },
            },
          ],
          stepRuns: [stepRun('lines', '2026-10-21T10:00:00.000Z', '2026-10-21T10:01:00.400Z')],
        }),
      ],
      3,
    );
    expect(d?.from).toEqual({ draftVersion: 3, jobIds: ['j1'], at: '2026-10-21T10:01:00.400Z' });
    expect(d?.steps).toEqual([
      { step: 'lines', sample: 'a.pdf', calls: 30, emptyCalls: 25, seconds: 60 },
    ]);
  });

  it('does not flag few calls, a low empty share, or a re-run event without counts', () => {
    const ev = (calls: number, emptyCalls: number) => ({
      message: 'extracted s',
      data: { calls, emptyCalls },
    });
    expect(runDiagnostics([run({ events: [ev(3, 3)] })], 1)).toBeNull();
    expect(runDiagnostics([run({ events: [ev(10, 4)] })], 1)).toBeNull();
    expect(
      runDiagnostics([run({ events: [{ message: 'extracted s', data: { model: 'm' } }] })], 1),
    ).toBeNull();
    expect(
      runDiagnostics([run({ events: [{ message: 'extracted s', data: 'junk' }] })], 1),
    ).toBeNull();
  });

  it('never flags a step served from the cache', () => {
    const d = runDiagnostics(
      [
        run({
          events: [
            { message: 'extracted s', data: { calls: 10, emptyCalls: 10 } },
            { message: 'reused cached s', data: { calls: 10, emptyCalls: 10 } },
          ],
          stepRuns: [stepRun('s', '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z', true)],
        }),
      ],
      1,
    );
    expect(d).toBeNull();
  });

  it('uses the newest non-cached step run for seconds', () => {
    const d = runDiagnostics(
      [
        run({
          events: [{ message: 're-ran s', data: { calls: 4, emptyCalls: 4 } }],
          stepRuns: [
            stepRun('s', '2026-10-21T10:00:00Z', '2026-10-21T10:00:10Z'),
            stepRun('s', '2026-10-21T11:00:00Z', '2026-10-21T11:00:05Z'),
            stepRun('s', '2026-10-21T12:00:00Z', '2026-10-21T12:00:00Z', true),
          ],
        }),
      ],
      1,
    );
    expect(d?.steps[0]?.seconds).toBe(5);
  });

  it('orders steps worst first and uses the given time', () => {
    const e = (s: string, calls: number, emptyCalls: number) => ({
      message: `extracted ${s}`,
      data: { calls, emptyCalls },
    });
    const d = runDiagnostics(
      [run({ events: [e('b', 10, 6), e('a', 10, 6), e('c', 8, 8)] })],
      1,
      '2026-01-01T00:00:00.000Z',
    );
    expect(d?.steps.map((s) => s.step)).toEqual(['c', 'a', 'b']);
    expect(d?.from.at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('groups normalisation issues by column with distinct examples', () => {
    const issues = Array.from({ length: 28 }, (_, i) => ({
      step: 's',
      target: 't',
      column: `c${i % 6}`,
      raw: `v${i % 5}`,
    }));
    const d = runDiagnostics([run({ issues })], 1);
    expect(d?.columns).toHaveLength(6);
    expect(d?.columns[0]?.issues).toBeGreaterThanOrEqual(d?.columns[5]?.issues ?? 0);
    for (const c of d?.columns ?? []) {
      expect(c.examples.length).toBeLessThanOrEqual(MAX_EXAMPLES);
      expect(new Set(c.examples).size).toBe(c.examples.length);
    }
    expect(d?.columns.reduce((n, c) => n + c.issues, 0)).toBe(28);
  });

  it('reports missed keys with the union of sections and the total', () => {
    const d = runDiagnostics(
      [
        run({
          events: [
            {
              message: 'segmented',
              data: {
                missedKeys: [
                  { sections: ['x', 'y'], key: '7', line: 'l' },
                  { sections: ['y', 'z'], key: '9', line: 'l' },
                ],
                missedKeysTotal: 40,
              },
            },
          ],
        }),
        run({
          jobId: 'j2',
          sample: 'b.pdf',
          events: [
            {
              message: 'segmented',
              data: { missedKeys: [{ sections: ['x'], key: '1', line: 'l' }] },
            },
          ],
        }),
      ],
      2,
    );
    expect(d?.missedKeys).toEqual([
      { sample: 'a.pdf', sections: ['x', 'y', 'z'], keys: ['7', '9'], total: 40 },
      { sample: 'b.pdf', sections: ['x'], keys: ['1'], total: 1 },
    ]);
    expect(d?.from.jobIds).toEqual(['j1', 'j2']);
  });

  it('keeps only the last segmented event of a run (a step re-run segments again)', () => {
    const seg = (key: string) => ({
      message: 'segmented',
      data: { missedKeys: [{ sections: ['x'], key, line: 'l' }] },
    });
    const d = runDiagnostics([run({ events: [seg('1'), seg('2')] })], 1);
    expect(d?.missedKeys).toEqual([{ sample: 'a.pdf', sections: ['x'], keys: ['2'], total: 1 }]);
    const cleared = runDiagnostics(
      [run({ events: [seg('1'), { message: 'segmented', data: {} }] })],
      1,
    );
    expect(cleared).toBeNull();
  });

  it('caps rows and counts them; null counts zero', () => {
    const issues = Array.from({ length: 30 }, (_, i) => ({
      step: 's',
      target: 't',
      column: `c${i}`,
      raw: 'x',
    }));
    const d = runDiagnostics([run({ issues })], 1);
    expect(d?.columns).toHaveLength(20);
    expect(diagnosticsCount(d)).toBe(20);
    expect(diagnosticsCount(null)).toBe(0);
  });

  it('is null when nothing is flagged', () => {
    expect(runDiagnostics([run()], 1)).toBeNull();
    expect(runDiagnostics([], 1)).toBeNull();
  });
});
