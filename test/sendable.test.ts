import { describe, expect, it } from 'vitest';
import {
  isSendable,
  type Recommendation,
  type ValidationResult,
} from '../src/index.js';

function result(
  recommendation: ValidationResult['recommendation'],
  recommendationRaw: ValidationResult['recommendationRaw'] = recommendation
): ValidationResult {
  return {
    email: 'user@example.com',
    status: 'valid',
    confidence: 80,
    mxFound: true,
    smtpValid: true,
    isDisposable: false,
    isCatchAll: false,
    isRoleAccount: false,
    fromCache: false,
    creditsUsed: 1,
    result: {},
    subStatus: null,
    recommendation,
    recommendationRaw,
    qualityScore: 80,
    explanation: null,
    didYouMean: null,
  };
}

describe('isSendable', () => {
  it('returns true for deliverable and send_with_caution', () => {
    expect(isSendable('deliverable')).toBe(true);
    expect(isSendable('send_with_caution')).toBe(true);
    expect(isSendable(result('deliverable'))).toBe(true);
    expect(isSendable(result('send_with_caution'))).toBe(true);
  });

  it('returns false for risky, undeliverable, and unknown', () => {
    for (const recommendation of [
      'risky',
      'undeliverable',
      'unknown',
    ] as const) {
      expect(isSendable(recommendation)).toBe(false);
      expect(isSendable(result(recommendation))).toBe(false);
    }
  });

  it('returns false (never throws) for a null or undefined recommendation', () => {
    expect(isSendable(null)).toBe(false);
    expect(isSendable(undefined)).toBe(false);
    expect(isSendable(result(null))).toBe(false);
  });

  it('returns false (never throws) for an unknown recommendation string', () => {
    // Simulate a server value this SDK version does not model. The normalized
    // recommendation is null, but the raw string is retained on the result.
    const withUnknown = result(null, 'brand_new_verdict');
    expect(isSendable(withUnknown)).toBe(false);
    // A raw unknown string passed directly must also be handled, not thrown on.
    expect(isSendable('brand_new_verdict' as Recommendation)).toBe(false);
  });
});
