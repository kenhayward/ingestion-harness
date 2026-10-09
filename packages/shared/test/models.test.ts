import { describe, expect, it } from 'vitest';
import { modelRef, parseModelRef } from '../src/models.js';
import { inboxKey, outputKey } from '../src/storage-keys.js';
import { isTerminal } from '../src/jobs.js';

describe('model refs', () => {
  it('round-trips provider/model ids, including ids containing slashes', () => {
    expect(parseModelRef(modelRef('local', 'meta/llama-3.1'))).toEqual({
      provider: 'local',
      modelId: 'meta/llama-3.1',
    });
  });

  it.each(['', 'noslash', '/model', 'provider/'])('rejects malformed ref %j', (ref) => {
    expect(parseModelRef(ref)).toBeNull();
  });
});

describe('storage keys', () => {
  it('builds inbox and output keys by convention', () => {
    expect(inboxKey('invoice', 2, 'doc-1')).toBe('invoice/v2/doc-1.pdf');
    expect(outputKey('invoice', 2, 'lines', 'doc-1', 'csv')).toBe('invoice/v2/lines/doc-1.csv');
  });
});

describe('job status', () => {
  it('treats succeeded, failed, needs_review and rejected as terminal', () => {
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('awaiting_review')).toBe(false); // waiting for a person, not finished
    expect(isTerminal('needs_review')).toBe(true);
    expect(isTerminal('rejected')).toBe(true);
  });
});
