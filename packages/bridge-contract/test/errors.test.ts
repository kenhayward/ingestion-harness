import { describe, expect, it } from 'vitest';
import {
  bridgeError,
  BridgeErrorSchema,
  documentMissing,
  isDocumentMissing,
} from '../src/index.js';

describe('bridge errors', () => {
  it('takes its class from the code', () => {
    expect(bridgeError('name_conflict', 'taken')).toEqual({
      class: 'needs_user',
      code: 'name_conflict',
      message: 'taken',
    });
    expect(bridgeError('timeout', 'slow').class).toBe('retryable');
  });

  it('keeps details when given', () => {
    expect(bridgeError('target_missing', 'no target', { targetId: 'x' }).details).toEqual({
      targetId: 'x',
    });
  });

  it('refuses unknown fields and bad codes', () => {
    expect(
      BridgeErrorSchema.safeParse({ class: 'retryable', code: 'Bad-Code', message: 'x' }).success,
    ).toBe(false);
    expect(
      BridgeErrorSchema.safeParse({ class: 'retryable', code: 'timeout', message: 'x', extra: 1 })
        .success,
    ).toBe(false);
  });

  it('marks a refused update of a document the target no longer has', () => {
    const missing = documentMissing('doc-1', 'Repository lib has no map doc-1');
    expect(missing).toEqual({
      class: 'needs_user',
      code: 'not_found',
      message: 'Repository lib has no map doc-1',
      details: { reason: 'document_missing', persistentId: 'doc-1' },
    });
    expect(BridgeErrorSchema.parse(missing)).toEqual(missing);
    expect(isDocumentMissing(missing, 'doc-1')).toBe(true);
  });

  it('a not_found without the marker, or naming another document, is no missing document', () => {
    expect(isDocumentMissing(bridgeError('not_found', 'no route'), 'doc-1')).toBe(false);
    expect(
      isDocumentMissing(
        bridgeError('not_found', 'the bridge has no record of this delivery'),
        'doc-1',
      ),
    ).toBe(false);
    expect(isDocumentMissing(documentMissing('doc-2', 'gone'), 'doc-1')).toBe(false);
    expect(isDocumentMissing(documentMissing('doc-1', 'gone'), null)).toBe(false);
    const otherCode = { ...documentMissing('doc-1', 'gone'), code: 'content_rejected' };
    expect(isDocumentMissing(otherCode, 'doc-1')).toBe(false);
    expect(isDocumentMissing(null, 'doc-1')).toBe(false);
  });
});
