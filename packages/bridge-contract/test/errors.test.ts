import { describe, expect, it } from 'vitest';
import { bridgeError, BridgeErrorSchema } from '../src/index.js';

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
});
