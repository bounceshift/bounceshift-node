import { describe, expect, it } from 'vitest';
import { isSafeToSend, type ValidationResult } from '../src/index.js';

function result(status: ValidationResult['status']): ValidationResult {
  return {
    email: 'user@example.com',
    status,
    confidence: 80,
    mxFound: true,
    smtpValid: true,
    isDisposable: false,
    isCatchAll: status === 'catch_all',
    isRoleAccount: false,
    fromCache: false,
    creditsUsed: 1,
    result: {},
    subStatus: null,
    recommendation: null,
    recommendationRaw: null,
    qualityScore: null,
    explanation: null,
    didYouMean: null,
  };
}

describe('isSafeToSend', () => {
  it('returns true for valid and catch_all', () => {
    expect(isSafeToSend('valid')).toBe(true);
    expect(isSafeToSend('catch_all')).toBe(true);
    expect(isSafeToSend(result('valid'))).toBe(true);
    expect(isSafeToSend(result('catch_all'))).toBe(true);
  });

  it('returns false for every other status', () => {
    for (const status of [
      'invalid',
      'risky',
      'unknown',
      'disposable',
      'spamtrap',
      'abuse',
      'do_not_mail',
    ] as const) {
      expect(isSafeToSend(status)).toBe(false);
      expect(isSafeToSend(result(status))).toBe(false);
    }
  });
});
